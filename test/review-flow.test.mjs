import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { draftComment } from '../src/review-flow.mjs';
import { listDrafts } from '../src/approvals.mjs';

const now = new Date(2026, 9, 19, 20, 0, 0);
const owner = { uid: 1511387074, name: 'Kylume', owner: true };
const config = {
  schedule: { only_offpeak: true, weekend_all_day: true, windows: { noon: ['12:00', '14:00'], night: ['18:00', '09:00'] }, stop_write_before_end_min: 10 },
  l1: { like_per_day: 20, coin_per_day: 1, favorite_per_day: 10 },
  l2: {
    comment_per_video: 1, reply_per_root: 2, comment_per_day: 3, reply_per_day: 10, total_per_day: 10,
    per_person_per_day: 1, comment_min_interval_sec: 600, danmaku_per_day: 5,
    dm_per_day: 10, dm_per_person_per_day: 3, dm_min_interval_sec: 300, dm_allow_links: false,
  },
  l3: { enabled: false, dynamic_per_day: 1 },
  review: { rule_engine: true, human_required: true },
  guard: { quiet_hours: ['00:00', '07:00'], killed_file: 'STOP' },
};

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'bili-flow-'));
}

async function run(draft = {}, options = {}) {
  const draftsDir = await tempDir();
  try {
    return {
      result: await draftComment({
        bvid: 'BV1E7wtzaEdq',
        content: '这个视频讲得清楚',
        config,
        allowlist: { allow: [owner] },
        entries: [],
        now,
        home: draftsDir,
        draftsDir,
        reviewTransport: async () => ({ verdict: 'pass', risk: 'low', reasons: ['技术观察'] }),
        ...draft,
        ...options,
      }),
      draftsDir,
    };
  } catch (error) {
    await rm(draftsDir, { recursive: true, force: true });
    throw error;
  }
}

test('a passing draft enters the human queue with @owner', async () => {
  const { result, draftsDir } = await run();
  try {
    assert.equal(result.ok, true);
    assert.equal(result.draft.status, 'pending');
    assert.match(result.draft.content, /^@Kylume /);
    assert.equal(result.ai.verdict, 'pass');
    assert.equal(result.requiresHuman, true);
    const queue = await listDrafts({ draftsDir, status: 'pending' });
    assert.equal(queue.total, 1);
    assert.equal(queue.entries[0].id, result.draft.id);
  } finally {
    await rm(draftsDir, { recursive: true, force: true });
  }
});

test('rule rejection stops before AI review', async () => {
  let aiCalled = false;
  const { result, draftsDir } = await run(
    { content: '加微信 abc123' },
    {
      reviewTransport: async () => {
        aiCalled = true;
        return { verdict: 'pass', risk: 'low', reasons: [] };
      },
    },
  );
  try {
    assert.equal(result.ok, false);
    assert.equal(result.rule.verdict, 'reject');
    assert.equal(aiCalled, false);
    const queue = await listDrafts({ draftsDir, status: 'pending' });
    assert.equal(queue.total, 0);
  } finally {
    await rm(draftsDir, { recursive: true, force: true });
  }
});

test('AI rejection stops before the queue', async () => {
  const { result, draftsDir } = await run(
    {},
    {
      reviewTransport: async () => ({ verdict: 'reject', risk: 'high', reasons: ['广告'] }),
    },
  );
  try {
    assert.equal(result.ok, false);
    assert.equal(result.ai.verdict, 'reject');
    assert.match(result.errors.join('；'), /广告/);
    const queue = await listDrafts({ draftsDir, status: 'pending' });
    assert.equal(queue.total, 0);
  } finally {
    await rm(draftsDir, { recursive: true, force: true });
  }
});

test('a missing AI reviewer fails closed to a human draft', async () => {
  const { result, draftsDir } = await run({}, { reviewTransport: null });
  try {
    assert.equal(result.ok, true);
    assert.equal(result.draft.status, 'pending');
    assert.equal(result.ai.verdict, 'human');
    assert.match(result.ai.reasons.join('；'), /未配置/);
  } finally {
    await rm(draftsDir, { recursive: true, force: true });
  }
});
