// Host-half end-to-end test: registers the route on a real http server and
// exercises GET/PUT, validation, and the loopback trust gate.
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-winpos-test-'));
const plugin = await import('./index.js');
const { buildAppleScript } = plugin;

// The AppleScript that actually moves/resizes the window:
//  - with size → sets position AND size
//  - without size → sets position only (backward compatible)
//  - process name defaults to the official client and is parameterized so the
//    same build serves "DeepSeek Harness" and "DSH Desktop" shells
assert.equal(
  buildAppleScript(1440, 100, 1187, 794),
  'tell application "System Events" to tell process "DeepSeek Harness"\n' +
    'set position of window 1 to {1440, 100}\n' +
    'set size of window 1 to {1187, 794}\n' +
    'end tell'
);
assert.equal(
  buildAppleScript(1440, 100),
  'tell application "System Events" to tell process "DeepSeek Harness"\n' +
    'set position of window 1 to {1440, 100}\n' +
    'end tell'
);
assert.equal(
  buildAppleScript(1440, 100, 1187, 794, 'DSH Desktop'),
  'tell application "System Events" to tell process "DSH Desktop"\n' +
    'set position of window 1 to {1440, 100}\n' +
    'set size of window 1 to {1187, 794}\n' +
    'end tell'
);

const registered = [];
plugin.apply({
  inject(names, fn) {
    if (names.includes('webServer')) {
      fn({ webServer: { register: (route) => registered.push(route) } });
    }
  },
});
assert.equal(registered.length, 3, 'bounds, diagnostic, and move routes registered');
assert.equal(registered.some((entry) => entry.path === '/window-position/bounds'), true);
assert.equal(registered.some((entry) => entry.path === '/window-position/diagnostic'), true);
assert.equal(registered.some((entry) => entry.path === '/window-position/move'), true);
const route = registered.find((entry) => entry.path === '/window-position/bounds');
const moveRoute = registered.find((entry) => entry.path === '/window-position/move');
const diagRoute = registered.find((entry) => entry.path === '/window-position/diagnostic');

const server = createServer((req, res) => route.handler(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const url = base + route.path;

const moveServer = createServer((req, res) => moveRoute.handler(req, res));
await new Promise((resolve) => moveServer.listen(0, '127.0.0.1', resolve));
const moveUrl = `http://127.0.0.1:${moveServer.address().port}${moveRoute.path}`;

const diagServer = createServer((req, res) => diagRoute.handler(req, res));
await new Promise((resolve) => diagServer.listen(0, '127.0.0.1', resolve));
const diagUrl = `http://127.0.0.1:${diagServer.address().port}${diagRoute.path}`;

try {
  // 1. GET with no saved state → ok, bounds null.
  let res = await fetch(url, { cache: 'no-store' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, bounds: null });

  // 2. PUT valid bounds → persisted, echoed, file written.
  const bounds = { x: 2016, y: 209, width: 1380, height: 900 };
  res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bounds),
  });
  assert.equal(res.status, 200);
  const saved = await res.json();
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.bounds, bounds);
  assert.deepEqual(
    JSON.parse(readFileSync(join(process.env.DSH_HOME, 'plugin-data', 'dsh-window-position', 'bounds.json'), 'utf8')),
    bounds
  );

  // 3. GET now returns the saved bounds.
  res = await fetch(url, { cache: 'no-store' });
  assert.deepEqual((await res.json()).bounds, bounds);

  // 3b. Position-only save (old format, no width/height) is still accepted and
  //     readable — backward compatibility for historical data.
  res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x: 3000, y: 500 }),
  });
  assert.equal(res.status, 200);
  res = await fetch(url, { cache: 'no-store' });
  assert.deepEqual((await res.json()).bounds, { x: 3000, y: 500 });
  // restore the full-bounds save for the rest of the tests
  res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bounds),
  });
  assert.equal(res.status, 200);

  // 4. Garbage payload → 422, file untouched.
  res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x: 'left', y: null, width: 10, height: {} }),
  });
  assert.equal(res.status, 422);

  // 5. Cross-origin PUT → 403.
  res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify(bounds),
  });
  assert.equal(res.status, 403);

  // 6. Tampered file (wrong shape) reads as "no saved state".
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    join(process.env.DSH_HOME, 'plugin-data', 'dsh-window-position', 'bounds.json'),
    '{"x":1}'
  );
  res = await fetch(url, { cache: 'no-store' });
  assert.deepEqual(await res.json(), { ok: true, bounds: null });

  // 7. Move route: invalid coordinates → 422 before any osascript call.
  res = await fetch(moveUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x: 'left', y: undefined }),
  });
  assert.equal(res.status, 422);

  // 8. Move route: cross-origin → 403.
  res = await fetch(moveUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ x: 100, y: 100 }),
  });
  assert.equal(res.status, 403);

  // 9. Diagnostic history: PUTs append (not overwrite) so a slow-restore
  //    investigation sees the full per-attempt timeline.
  for (const stage of ['restore-start', 'restore-attempt', 'restore-finished']) {
    res = await fetch(diagUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage }),
    });
    assert.equal(res.status, 200);
  }
  res = await fetch(diagUrl, { cache: 'no-store' });
  const history = (await res.json()).diagnostic;
  assert.equal(Array.isArray(history), true);
  assert.deepEqual(history.map((entry) => entry.value.stage), [
    'restore-start',
    'restore-attempt',
    'restore-finished',
  ]);

  console.log('host-half tests: all passed');
} finally {
  server.close();
  moveServer.close();
  diagServer.close();
}
