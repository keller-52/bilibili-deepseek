import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

async function withServer(run, options = {}) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('health endpoint answers', async () => {
  await withServer(async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
  });
});

test('index page is served with a CSP header', async () => {
  await withServer(async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    const html = await response.text();
    assert.match(html, /bili-duty 控制台/);
  });
});

test('config endpoint exposes groups and data', async () => {
  await withServer(async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/config`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.groups) && body.groups.length >= 5);
    assert.equal(typeof body.data.l2.dm_per_day, 'number');
  });
});

test('unknown API returns 404 JSON', async () => {
  await withServer(async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/nope`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.match(body.error, /未知接口/);
  });
});

test('cross-origin writes are refused', async () => {
  await withServer(async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ patch: {} }),
    });
    assert.equal(response.status, 403);
  });
});

test('same-origin writes are allowed', async () => {
  await withServer(async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ patch: {} }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
  });
});

test('unknown config keys are rejected without touching the file', async () => {
  await withServer(async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: { 'nope.key': 1 } }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /未知参数/);
  });
});

test('mounts under a base path for the DSH plugin', async () => {
  await withServer(
    async (port) => {
      const base = `http://127.0.0.1:${port}/bili-duty`;

      const redirect = await fetch(`http://127.0.0.1:${port}/bili-duty`, { redirect: 'manual' });
      assert.equal(redirect.status, 302);
      assert.equal(redirect.headers.get('location'), '/bili-duty/');

      const page = await fetch(`${base}/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'self'/);
      assert.match(await page.text(), /styles\.css/);

      const health = await fetch(`${base}/api/health`);
      assert.equal((await health.json()).ok, true);

      const asset = await fetch(`${base}/app.js`);
      assert.equal(asset.status, 200);
      assert.match(await asset.text(), /API_ROOT/);

      const outside = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(outside.status, 404);
    },
    { basePath: '/bili-duty', allowFrame: true },
  );
});
