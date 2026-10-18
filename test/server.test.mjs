import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

async function withServer(run) {
  const server = createServer();
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
    assert.equal(body.data.l2.dm_per_day, 10);
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
