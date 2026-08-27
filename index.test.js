// Host-half end-to-end test: registers the route on a real http server and
// exercises GET/PUT, validation, and the loopback trust gate.
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-winpos-test-'));
const plugin = await import('./index.js');

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

const server = createServer((req, res) => route.handler(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const url = base + route.path;

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

  console.log('host-half tests: all passed');
} finally {
  server.close();
}
