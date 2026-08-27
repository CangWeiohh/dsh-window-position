// dsh-window-position — host half.
//
// Registers one loopback route on the harness webserver:
//   GET /window-position/bounds  → { ok, bounds }   (bounds null until first save)
//   PUT /window-position/bounds  → persist { x, y, width, height }
// Storage: ${DSH_HOME:-~/.dsh}/plugin-data/dsh-window-position/bounds.json
//
// The browser half (client.js) moves the DSH Desktop window with
// window.moveTo()/window.resizeTo() and reports bounds back here. Same-origin
// localStorage cannot carry this state across launches: the desktop app
// reserves a fresh random webserver port on every start, so the page origin
// changes each run. The file behind this route is the durable copy.
//
// Loopback request gate mirrors @liustack/modsearch's settings-card route:
// loopback Host, no cross-site Sec-Fetch-Site, same-origin Origin when sent.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';

export const name = 'dsh-window-position';

const ROUTE_PATH = '/window-position/bounds';
const DIAGNOSTIC_PATH = '/window-position/diagnostic';
const MOVE_PATH = '/window-position/move';
const MAX_BODY_BYTES = 2048;
const LIMIT = { offset: 32768, width: 16384, height: 16384 };

// window.moveTo() cannot cross displays in the real DSH Desktop (the window is
// 1380x900 on a 1440x900 built-in, so Chromium clamps it to the primary
// display). osascript + System Events CAN cross displays (verified), so the
// host half moves the window through Accessibility instead of the renderer.
function moveWindow(x, y) {
  return new Promise((resolve, reject) => {
    const script = `tell application "System Events" to tell process "DSH Desktop" to set position of window 1 to {${Math.round(x)}, ${Math.round(y)}}`;
    execFile('osascript', ['-e', script], { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim()));
      else resolve();
    });
  });
}

function dataFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'plugin-data', 'dsh-window-position', 'bounds.json');
}

// Accepts only a plain {x,y,width,height} of finite numbers in sane ranges;
// anything else (tampered file, partial write, wrong shape) reads as "no
// saved state" so the browser half simply keeps the stock centered window.
function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const n = Number(value[key]);
    if (!Number.isFinite(n)) return null;
    out[key] = Math.round(n);
  }
  if (Math.abs(out.x) > LIMIT.offset || Math.abs(out.y) > LIMIT.offset) return null;
  if (out.width < 200 || out.width > LIMIT.width) return null;
  if (out.height < 120 || out.height > LIMIT.height) return null;
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

function writeDiagnostic(value) {
  const file = diagnosticFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, 'utf8');
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
          }
          if (req.method === 'PUT' || req.method === 'POST') {
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
            await moveWindow(x, y);
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
    } catch (error) {
      console.error(`[dsh-window-position] route registration skipped: ${error}`);
    }
  });
}
