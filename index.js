// dsh-window-position — host half.
//
// Registers one loopback route on the harness webserver:
//   GET /window-position/bounds  → { ok, bounds }   (bounds null until first save)
//   PUT /window-position/bounds  → persist { x, y, width, height }
// Storage: ${DSH_HOME:-~/.dsh}/plugin-data/dsh-window-position/bounds.json
//
// The browser half (client.js) asks this host half to move the DSH window via
// /window-position/move (osascript + System Events, because window.moveTo()
// cannot cross displays) and reports bounds back here.
// Same-origin localStorage cannot carry this state across launches where the
// webserver port changes per run (DSH Desktop reserves a random port; the
// DeepSeek Harness client pins 19387 but the file copy is durable either way).
//
// Loopback request gate mirrors @liustack/modsearch's settings-card route:
// loopback Host, no cross-site Sec-Fetch-Site, same-origin Origin when sent.
// The DeepSeek Harness client additionally loads the page from dsh-app://app
// and forwards API calls to the webserver with those headers stripped, which
// passes this gate unchanged.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';

export const name = 'dsh-window-position';
export { buildAppleScript, runHostAutoRestore };

const ROUTE_PATH = '/window-position/bounds';
const DIAGNOSTIC_PATH = '/window-position/diagnostic';
const MOVE_PATH = '/window-position/move';
const MAX_BODY_BYTES = 2048;
const LIMIT = { offset: 32768, width: 16384, height: 16384 };

// Two known desktop shells ship this harness: DSH Desktop (process "DSH
// Desktop") and the official DeepSeek Harness client (process "DeepSeek
// Harness"). osascript can only target one process name, so the host half
// probes the candidates once and caches the first that exists; the probe runs
// in the same process tree as the later moves, so TCC attributes it to the
// same app. DSH_WINDOW_PROCESS_NAME overrides the probe entirely.
const PROCESS_CANDIDATES = ['DeepSeek Harness', 'DSH Desktop'];

let resolvedProcessName;

function processNameCandidates() {
  const override = process.env.DSH_WINDOW_PROCESS_NAME;
  if (typeof override === 'string' && override.trim() !== '') return [override.trim()];
  return PROCESS_CANDIDATES;
}

function probeProcessExists(name) {
  return new Promise((resolve) => {
    const script = `tell application "System Events" to exists process "${name}"`;
    execFile('osascript', ['-e', script], { timeout: 2000 }, (error, stdout) => {
      resolve(!error && String(stdout).trim() === 'true');
    });
  });
}

async function resolveProcessName() {
  if (resolvedProcessName !== undefined) return resolvedProcessName;
  const candidates = processNameCandidates();
  for (const name of candidates) {
    // eslint-disable-next-line no-await-in-loop -- probe is cheap and must be ordered
    if (await probeProcessExists(name)) {
      resolvedProcessName = name;
      return name;
    }
  }
  // No candidate is running (or Accessibility is denied): default to the
  // official client and let the move surface the real error in diagnostics.
  resolvedProcessName = candidates[0];
  return resolvedProcessName;
}

// window.moveTo() cannot cross displays in the real DSH Desktop (the window is
// 1380x900 on a 1440x900 built-in, so Chromium clamps it to the primary
// display). osascript + System Events CAN cross displays (verified), so the
// host half moves the window through Accessibility instead of the renderer.
//
// width/height are optional: when finite they are applied as the window size
// too, so a manually resized window is restored as well as its position.
function buildAppleScript(x, y, width, height, processName = 'DeepSeek Harness') {
  const statements = [`set position of window 1 to {${Math.round(x)}, ${Math.round(y)}}`];
  if (Number.isFinite(width) && Number.isFinite(height)) {
    statements.push(`set size of window 1 to {${Math.round(width)}, ${Math.round(height)}}`);
  }
  return `tell application "System Events" to tell process "${processName}"\n${statements.join('\n')}\nend tell`;
}

async function moveWindow(x, y, width, height) {
  const processName = await resolveProcessName();
  const script = buildAppleScript(x, y, width, height, processName);
  return new Promise((resolve, reject) => {
    // 2s cap: during DSH 0.9.x boot the app is busy and Apple Events can hang;
    // a 5s timeout burned ~5s PER retry attempt (3 x 5.4s ≈ 16.5s slow restore).
    execFile('osascript', ['-e', script], { timeout: 2000 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim()));
      else resolve();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Host-side auto-restore: the harness process boots BEFORE the Electron window
// is shown, so polling here catches the window the moment it enters the
// accessibility hierarchy (~0-300ms after it appears) — no dependency on web
// app boot or renderer network readiness (busy boots queued renderer fetches
// for 20s+, which made renderer-driven restore take 2.6s-24s). The loop
// re-reads bounds.json every attempt and aborts when the file changed, so it
// never fights a position the renderer just saved (user's own drag).
const HOST_RESTORE_INTERVAL_MS = 300;
const HOST_RESTORE_MAX_ATTEMPTS = 60; // ≈18s of boot coverage
let hostRestoreStarted = false;

function hostAutoRestoreDisabled() {
  return process.env.DSH_WINDOW_POSITION_HOST_RESTORE === 'off';
}

async function runHostAutoRestore() {
  // The kill switch is checked here too, not just at the apply() trigger:
  // direct callers (tests, tools) must never be able to move a real window
  // through a bounds file they did not intend to act on.
  if (hostAutoRestoreDisabled()) return;
  const initial = readBounds();
  if (!initial) return;
  const initialJson = JSON.stringify(initial);
  writeDiagnostic({ stage: 'host-restore-start', target: initial });
  for (let attempt = 1; attempt <= HOST_RESTORE_MAX_ATTEMPTS; attempt += 1) {
    const current = readBounds();
    if (!current || JSON.stringify(current) !== initialJson) {
      writeDiagnostic({ stage: 'host-restore-abort', attempt, reason: 'bounds changed' });
      return;
    }
    try {
      await moveWindow(initial.x, initial.y, initial.width, initial.height);
      writeDiagnostic({ stage: 'host-restore-attempt', attempt, ok: true });
      return;
    } catch (error) {
      // Window not in the accessibility hierarchy yet (or Accessibility
      // denied) — the window simply has not appeared; keep the loop bounded.
      if (attempt === HOST_RESTORE_MAX_ATTEMPTS) {
        writeDiagnostic({
          stage: 'host-restore-attempt',
          attempt,
          ok: false,
          error: String(error?.message ?? error).slice(0, 200),
        });
      }
    }
    await sleep(HOST_RESTORE_INTERVAL_MS);
  }
}

function dataFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'plugin-data', 'dsh-window-position', 'bounds.json');
}

// Accepts only a plain object of finite numbers in sane ranges; anything else
// (tampered file, partial write, wrong shape) reads as "no saved state" so the
// browser half simply keeps the stock centered window.
// x/y are required; width/height are OPTIONAL (older saves only had position),
// so a position-only save still restores the move without changing the size.
function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of ['x', 'y']) {
    const n = Number(value[key]);
    if (!Number.isFinite(n)) return null;
    out[key] = Math.round(n);
  }
  if (Math.abs(out.x) > LIMIT.offset || Math.abs(out.y) > LIMIT.offset) return null;
  for (const key of ['width', 'height']) {
    if (value[key] === undefined || value[key] === null) continue;
    const n = Number(value[key]);
    if (!Number.isFinite(n)) return null;
    out[key] = Math.round(n);
  }
  if (out.width !== undefined && (out.width < 200 || out.width > LIMIT.width)) return null;
  if (out.height !== undefined && (out.height < 120 || out.height > LIMIT.height)) return null;
  return out;
}

function readBounds() {
  try {
    return normalize(JSON.parse(readFileSync(dataFile(), 'utf8')));
  } catch {
    return null;
  }
}

function writeBounds(bounds) {
  const file = dataFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(bounds)}\n`, 'utf8');
  renameSync(tmp, file);
}

function diagnosticFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'plugin-data', 'dsh-window-position', 'diagnostic.json');
}

function readDiagnostic() {
  try {
    return JSON.parse(readFileSync(diagnosticFile(), 'utf8'));
  } catch {
    return null;
  }
}

const DIAGNOSTIC_KEEP = 60;

// Append (not overwrite) so a slow-restore investigation can see the full
// per-attempt timeline of the last launch(es), not just the final event.
function writeDiagnostic(value) {
  const file = diagnosticFile();
  mkdirSync(dirname(file), { recursive: true });
  let history = [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) history = parsed;
  } catch {
    // first write or unreadable file — start a fresh history
  }
  history.push(value);
  if (history.length > DIAGNOSTIC_KEEP) history = history.slice(-DIAGNOSTIC_KEEP);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(history)}\n`, 'utf8');
  renameSync(tmp, file);
}


function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function isTrustedRequest(req) {
  const host = req.headers?.host;
  if (typeof host !== 'string' || host === '') return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!isLoopbackHost(hostUrl.hostname)) return false;
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers?.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function apply(ctx) {
  if (typeof ctx?.inject !== 'function') return;
  // webServer exists only under the web profile; the scoped inject keeps this
  // plugin loadable everywhere while the route rides only where it belongs.
  ctx.inject(['webServer'], (scope) => {
    try {
      scope.webServer.register({
        name: 'dsh-window-position-diagnostic',
        kind: 'exact',
        path: DIAGNOSTIC_PATH,
        handler: async (req, res) => {
          const send = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(body));
          };
          if (!isTrustedRequest(req)) {
            send(403, { ok: false });
            return;
          }
          if (req.method === 'GET') {
            send(200, { ok: true, diagnostic: readDiagnostic() });
            return;
          }          if (req.method === 'PUT' || req.method === 'POST') {
            try {
              const value = JSON.parse(await readBody(req));
              writeDiagnostic({ at: new Date().toISOString(), value });
              send(200, { ok: true });
            } catch (error) {
              send(400, { ok: false, error: String(error?.message ?? error) });
            }
            return;
          }
          res.writeHead(405).end();
        },
      });

      scope.webServer.register({
        name: 'dsh-window-position-move',
        kind: 'exact',
        path: MOVE_PATH,
        handler: async (req, res) => {
          const send = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(body));
          };
          if (!isTrustedRequest(req)) {
            send(403, { ok: false });
            return;
          }
          if (req.method !== 'POST') {
            res.writeHead(405).end();
            return;
          }
          try {
            const body = JSON.parse(await readBody(req));
            const x = Number(body.x);
            const y = Number(body.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
              send(422, { ok: false, error: 'invalid coordinates' });
              return;
            }
            const width = Number(body.width);
            const height = Number(body.height);
            const wantSize = Number.isFinite(width) && Number.isFinite(height);
            await moveWindow(x, y, wantSize ? width : undefined, wantSize ? height : undefined);
            send(200, { ok: true });
          } catch (error) {
            send(500, { ok: false, error: String(error?.message ?? error) });
          }
        },
      });

      scope.webServer.register({
        name: 'dsh-window-position-bounds',
        kind: 'exact',
        path: ROUTE_PATH,
        handler: async (req, res) => {
          const send = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(body));
          };
          if (!isTrustedRequest(req)) {
            send(403, { ok: false, error: 'request refused: this route answers same-origin loopback only' });
            return;
          }
          if (req.method === 'GET') {
            send(200, { ok: true, bounds: readBounds() });
            return;
          }
          if (req.method === 'PUT' || req.method === 'POST') {
            try {
              const bounds = normalize(JSON.parse(await readBody(req)));
              if (!bounds) {
                send(422, { ok: false, error: 'invalid bounds payload' });
                return;
              }
              writeBounds(bounds);
              send(200, { ok: true, bounds });
            } catch (error) {
              send(400, { ok: false, error: String(error?.message ?? error) });
            }
            return;
          }
          res.writeHead(405).end();
        },
      });

      // Restore from the host as early as possible: the harness boots before
      // the Electron window is shown, so this loop usually moves the window
      // within ~300ms of it appearing. The browser half stays as a fallback.
      if (!hostRestoreStarted && !hostAutoRestoreDisabled()) {
        hostRestoreStarted = true;
        void runHostAutoRestore().catch((error) => {
          console.error(`[dsh-window-position] host auto-restore failed: ${error}`);
        });
      }
    } catch (error) {
      console.error(`[dsh-window-position] route registration skipped: ${error}`);
    }
  });
}
