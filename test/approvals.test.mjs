import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  approveDraft,
  consumeApproval,
  createDraft,
  getDraft,
  hashToken,
  listDrafts,
  rejectDraft,
} from '../src/approvals.mjs';

async function tempDrafts() {
  return mkdtemp(path.join(os.tmpdir(), 'bili-drafts-'));
}

const now = new Date('2026-10-19T12:00:00.000Z');

async function make(draftsDir, overrides = {}) {
  const result = await createDraft(
    {
      action: 'comment',
      target: { bvid: 'BV1E7wtzaEdq' },
      content: '@Kylume 这个视频讲得清楚',
      rule: { verdict: 'human', risk: 'medium', reasons: ['超过 100 字'] },
      ai: { verdict: 'pass', risk: 'low', reasons: ['技术观察'] },
      ...overrides,
    },
    { draftsDir, now },
  );
  assert.equal(result.ok, true);
  return result.draft;
}

test('drafts are appended to the pending queue', async () => {
  const dir = await tempDrafts();
  try {
    const first = await make(dir);
    await make(dir, { content: '@Kylume 第二条' });
    const list = await listDrafts({ draftsDir: dir });
    assert.equal(list.total, 2);
    assert.equal(list.entries.length, 2);
    assert.deepEqual(
      list.entries.map((entry) => entry.content).sort(),
      ['@Kylume 第二条', '@Kylume 这个视频讲得清楚'].sort(),
    );
    for (const entry of list.entries) {
      assert.equal(entry.status, 'pending');
      assert.equal(entry.action, 'comment');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('approval returns a one-time token and stores only its hash', async () => {
  const dir = await tempDrafts();
  try {
    const draft = await make(dir);
    const approved = await approveDraft(draft.id, { draftsDir: dir, now, ttlMs: 300_000 });
    assert.equal(approved.ok, true);
    assert.equal(typeof approved.token, 'string');
    assert.equal(approved.draft.status, 'approved');

    const raw = await readFile(path.join(dir, `${draft.id}.json`), 'utf8');
    assert.equal(raw.includes(approved.token), false);
    assert.match(raw, new RegExp(hashToken(approved.token)));

    const listed = await listDrafts({ draftsDir: dir, status: 'all' });
    assert.equal(listed.entries[0].approval.tokenHash, undefined);
    assert.equal(listed.entries[0].approval.usedAt, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the token is consumed once and then rejected', async () => {
  const dir = await tempDrafts();
  try {
    const draft = await make(dir);
    const approved = await approveDraft(draft.id, { draftsDir: dir, now });
    const consumed = await consumeApproval(draft.id, approved.token, { draftsDir: dir, now: new Date(now.getTime() + 1000) });
    assert.equal(consumed.ok, true);
    assert.equal(consumed.draft.status, 'used');

    const replay = await consumeApproval(draft.id, approved.token, { draftsDir: dir, now: new Date(now.getTime() + 2000) });
    assert.equal(replay.ok, false);
    assert.match(replay.errors.join('；'), /用过|没有可用/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('wrong token and expired token are rejected', async () => {
  const dir = await tempDrafts();
  try {
    const draft = await make(dir);
    const approved = await approveDraft(draft.id, { draftsDir: dir, now, ttlMs: 30_000 });
    const wrong = await consumeApproval(draft.id, 'not-the-token', { draftsDir: dir, now });
    assert.equal(wrong.ok, false);
    assert.match(wrong.errors.join('；'), /不匹配/);

    const expired = await consumeApproval(draft.id, approved.token, { draftsDir: dir, now: new Date(now.getTime() + 31_000) });
    assert.equal(expired.ok, false);
    assert.match(expired.errors.join('；'), /过期/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejected drafts cannot be approved later', async () => {
  const dir = await tempDrafts();
  try {
    const draft = await make(dir);
    const rejected = await rejectDraft(draft.id, { draftsDir: dir, now, reason: '语气不合适' });
    assert.equal(rejected.ok, true);
    assert.equal(rejected.draft.status, 'rejected');
    const approved = await approveDraft(draft.id, { draftsDir: dir, now });
    assert.equal(approved.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid ids cannot escape the drafts directory', async () => {
  let dir = await tempDrafts();
  try {
    assert.equal(await getDraft('../config.yaml', { draftsDir: dir }), null);
    assert.equal(await getDraft('draft-abc-000000', { draftsDir: dir }), null);
    const missing = await listDrafts({ draftsDir: path.join(dir, 'missing') });
    assert.equal(missing.missing, true);
    const files = await readdir(dir);
    assert.deepEqual(files, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
