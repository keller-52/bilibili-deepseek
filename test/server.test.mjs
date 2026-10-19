import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';

async function withServer(run, options = {}) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(port);
  } finally {
    server.closeAllConnections?.();
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

test('status exposes the read-only memory summary', async () => {
  await withServer(async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.memory.total, 'number');
    assert.match(body.paths.memory, /runtime[\\/]memory$/);
  });
});

test('read-only endpoints validate input before touching the browser', async () => {
  await withServer(async (port) => {
    const empty = await fetch(`http://127.0.0.1:${port}/api/read/search?q=`);
    assert.equal(empty.status, 400);
    const emptyBody = await empty.json();
    assert.equal(emptyBody.ok, false);
    assert.match(emptyBody.errors[0], /关键词/);

    const badBvid = await fetch(`http://127.0.0.1:${port}/api/read/video?bvid=av170001`);
    assert.equal(badBvid.status, 400);
    const badBody = await badBvid.json();
    assert.match(badBody.errors[0], /BV/);

    const watched = await fetch(`http://127.0.0.1:${port}/api/read/watched?limit=5`);
    assert.equal(watched.status, 200);
    const watchedBody = await watched.json();
    assert.ok(Array.isArray(watchedBody.entries));
    assert.match(watchedBody.file, /watched\.jsonl$/);

    const ready = await fetch(`http://127.0.0.1:${port}/api/read/ready`);
    assert.equal(ready.status, 200);
    const readyBody = await ready.json();
    assert.equal(readyBody.ok, true);
    assert.equal(typeof readyBody.memory.total, 'number');
  });
});

test('cross-origin read-only requests are refused', async () => {
  await withServer(async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/read/watched`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(response.status, 403);
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

test('DM availability and validation endpoints answer without sending', async () => {
  await withServer(async (port) => {
    const probe = await fetch(`http://127.0.0.1:${port}/api/dm/owner`);
    assert.equal(probe.status, 200);
    const info = await probe.json();
    assert.equal(info.available, true);

    const empty = await fetch(`http://127.0.0.1:${port}/api/dm/owner`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '' }),
    });
    assert.equal(empty.status, 400);
    const body = await empty.json();
    assert.equal(body.ok, false);
    assert.match(body.errors[0], /不能为空/);
  });
});

test('review draft, queue and approval token flow', async () => {
  const drafts = await mkdtemp(path.join(os.tmpdir(), 'bili-review-http-'));
  try {
    await withServer(
      async (port) => {
        const ready = await fetch(`http://127.0.0.1:${port}/api/review/ready`);
        assert.equal(ready.status, 200);
        assert.equal((await ready.json()).ai, 'http');

        const created = await fetch(`http://127.0.0.1:${port}/api/review/draft`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bvid: 'BV1E7wtzaEdq', content: '这个视频讲得清楚' }),
        });
        assert.equal(created.status, 200);
        const draft = await created.json();
        assert.equal(draft.ok, true);
        assert.equal(draft.draft.status, 'pending');
        assert.match(draft.draft.content, /^@Kylume /);
        assert.equal(draft.ai.verdict, 'pass');

        const queue = await fetch(`http://127.0.0.1:${port}/api/review/queue?status=pending`);
        assert.equal(queue.status, 200);
        const queueBody = await queue.json();
        assert.equal(queueBody.total, 1);
        assert.equal(queueBody.entries[0].approval, null);

        const approved = await fetch(`http://127.0.0.1:${port}/api/review/${draft.draft.id}/approve`, {
          method: 'POST',
        });
        assert.equal(approved.status, 200);
        const approvedBody = await approved.json();
        assert.equal(approvedBody.ok, true);
        assert.equal(typeof approvedBody.token, 'string');
        assert.equal(approvedBody.draft.status, 'approved');

        const missingToken = await fetch(`http://127.0.0.1:${port}/api/comment/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draftId: draft.draft.id, dryRun: false }),
        });
        assert.equal(missingToken.status, 400);
        assert.match((await missingToken.json()).errors[0], /令牌/);
      },
      {
        reviewTransport: async () => ({ verdict: 'pass', risk: 'low', reasons: ['技术观察'] }),
        draftsDir: drafts,
      },
    );
  } finally {
    await rm(drafts, { recursive: true, force: true });
  }
});

test('cross-origin review queue reads are refused', async () => {
  await withServer(async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/review/queue`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(response.status, 403);
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

      const dm = await fetch(`${base}/api/dm/owner`);
      assert.equal(dm.status, 200);
      assert.equal((await dm.json()).available, true);

      const asset = await fetch(`${base}/app.js`);
      assert.equal(asset.status, 200);
      assert.match(await asset.text(), /API_ROOT/);

      const outside = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(outside.status, 404);
    },
    { basePath: '/bili-duty', allowFrame: true },
  );
});
