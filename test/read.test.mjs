import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_COMMENTS,
  MAX_SEARCH_LIMIT,
  normalizeCommentLimit,
  normalizeOrder,
  normalizeQuery,
  normalizeSearchLimit,
  parseBvid,
} from '../src/read.mjs';

test('parseBvid accepts BV ids and full video URLs', () => {
  assert.equal(parseBvid('BV1E7wtzaEdq'), 'BV1E7wtzaEdq');
  assert.equal(parseBvid(' https://www.bilibili.com/video/BV1E7wtzaEdq/?p=2 '), 'BV1E7wtzaEdq');
  assert.equal(parseBvid('https://www.bilibili.com/video/BV1VZWc6dECG'), 'BV1VZWc6dECG');
  assert.equal(parseBvid('av170001'), null);
  assert.equal(parseBvid(''), null);
});

test('search query is trimmed, collapsed and length-limited', () => {
  assert.deepEqual(normalizeQuery('  AI   Agent  '), { ok: true, query: 'AI Agent' });
  assert.equal(normalizeQuery('').ok, false);
  assert.equal(normalizeQuery('   ').ok, false);
  assert.equal(normalizeQuery('字'.repeat(51)).ok, false);
});

test('search and comment limits enforce the supported ranges', () => {
  assert.deepEqual(normalizeSearchLimit(5), { ok: true, limit: 5 });
  assert.deepEqual(normalizeSearchLimit('10'), { ok: true, limit: 10 });
  assert.equal(normalizeSearchLimit(0).ok, false);
  assert.equal(normalizeSearchLimit(MAX_SEARCH_LIMIT + 1).ok, false);
  assert.equal(normalizeSearchLimit('abc').ok, false);

  assert.deepEqual(normalizeCommentLimit(0), { ok: true, limit: 0 });
  assert.deepEqual(normalizeCommentLimit('20'), { ok: true, limit: 20 });
  assert.equal(normalizeCommentLimit(-1).ok, false);
  assert.equal(normalizeCommentLimit(MAX_COMMENTS + 1).ok, false);
});

test('comment order accepts Chinese and English names', () => {
  assert.deepEqual(normalizeOrder('hot'), { ok: true, order: 'hot' });
  assert.deepEqual(normalizeOrder('最热'), { ok: true, order: 'hot' });
  assert.deepEqual(normalizeOrder('new'), { ok: true, order: 'new' });
  assert.deepEqual(normalizeOrder('最新'), { ok: true, order: 'new' });
  assert.equal(normalizeOrder('random').ok, false);
});
