import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  appendDailyNote,
  appendWatched,
  memoryDate,
  normalizeWatchedEntry,
  readWatched,
} from '../src/memory.mjs';

async function tempMemory() {
  return mkdtemp(path.join(os.tmpdir(), 'bili-memory-'));
}

test('watched entries are normalised and capped', () => {
  const entry = normalizeWatchedEntry({
    bvid: ' BV1E7wtzaEdq ',
    title: '  标题\n换行  ',
    author: 'UP',
    authorUid: '123',
    duration: '32:31',
    play: '211.3万',
    like: '10万',
    commentsRead: '20',
    commentPreview: '顶 评论',
    note: ' 笔记 ',
  });
  assert.equal(entry.bvid, 'BV1E7wtzaEdq');
  assert.equal(entry.title, '标题 换行');
  assert.equal(entry.authorUid, 123);
  assert.equal(entry.commentsRead, 20);
  assert.equal(entry.commentPreview, '顶 评论');
  assert.equal(entry.note, '笔记');
  assert.match(entry.url, /\/video\/BV1E7wtzaEdq$/);
});

test('watched.jsonl is append-only and read newest first', async () => {
  const dir = await tempMemory();
  try {
    const first = await appendWatched(dir, {
      bvid: 'BV1E7wtzaEdq',
      title: '第一条',
      commentsRead: 2,
    });
    assert.ok(first.file.endsWith('watched.jsonl'));
    await appendWatched(dir, { bvid: 'BV1VZWc6dECG', title: '第二条', commentsRead: 5 });

    const data = await readWatched(dir, 10);
    assert.equal(data.total, 2);
    assert.equal(data.invalid, 0);
    assert.equal(data.missing, false);
    assert.deepEqual(
      data.entries.map((entry) => entry.title),
      ['第二条', '第一条'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('missing watched file is reported, not thrown', async () => {
  const dir = await tempMemory();
  try {
    const data = await readWatched(dir, 10);
    assert.equal(data.missing, true);
    assert.equal(data.total, 0);
    assert.deepEqual(data.entries, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('malformed lines are counted and skipped', async () => {
  const dir = await tempMemory();
  try {
    await writeFile(
      path.join(dir, 'watched.jsonl'),
      `${JSON.stringify({ bvid: 'BV1E7wtzaEdq', title: 'ok' })}\nnot json\n`,
      'utf8',
    );
    const data = await readWatched(dir, 10);
    assert.equal(data.total, 1);
    assert.equal(data.invalid, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('daily note gets one header and one bullet per read', async () => {
  const dir = await tempMemory();
  const now = new Date(2026, 9, 19, 1, 2, 3);
  try {
    const first = await appendDailyNote(
      dir,
      {
        bvid: 'BV1E7wtzaEdq',
        title: '从 LLM 到 Agent Skill',
        author: '马克的技术工作坊',
        duration: '32:31',
        commentsRead: 20,
        commentPreview: '一个问题耗我110万token',
      },
      now,
    );
    assert.equal(first.date, '2026-10-19');
    await appendDailyNote(dir, { bvid: 'BV1VZWc6dECG', title: '第二条' }, now);

    const text = await readFile(first.file, 'utf8');
    assert.equal((text.match(/# 2026-10-19 看过/g) ?? []).length, 1);
    assert.equal((text.match(/^- /gm) ?? []).length, 2);
    assert.match(text, /从 LLM 到 Agent Skill/);
    assert.match(text, /一个问题耗我110万token/);
    assert.equal(memoryDate(now), '2026-10-19');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
