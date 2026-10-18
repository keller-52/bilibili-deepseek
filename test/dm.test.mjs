import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDmQuota, validateDmText } from '../src/dm.mjs';

const config = { l2: { dm_per_day: 10, dm_per_person_per_day: 3, dm_min_interval_sec: 300 } };
const ownerUid = 1511387074;

function entry(ts, overrides = {}) {
  return {
    ts,
    action: 'dm',
    target: ownerUid,
    exec: 'ok',
    ...overrides,
  };
}

test('DM text rejects empty content, links and overlong text', () => {
  assert.equal(validateDmText('').ok, false);
  assert.equal(validateDmText('看这个 https://example.com').ok, false);
  assert.equal(validateDmText('b23.tv/abc').ok, false);
  assert.equal(validateDmText('字'.repeat(301)).ok, false);
  assert.equal(validateDmText('你好，我是小深').ok, true);
});

test('DM quota passes with no history', () => {
  const result = checkDmQuota(config, [], ownerUid, Date.now());
  assert.equal(result.ok, true);
});

test('DM quota blocks too soon after the last message', () => {
  const now = Date.now();
  const result = checkDmQuota(config, [entry(new Date(now - 60_000).toISOString())], ownerUid, now);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /最小间隔/);
});

test('DM quota blocks the fourth message to the owner today', () => {
  const now = Date.now();
  const entries = [1, 2, 3].map((minutes) => entry(new Date(now - minutes * 10 * 60_000).toISOString()));
  const result = checkDmQuota(config, entries, ownerUid, now);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /主人/);
});

test('failed sends do not count against the quota', () => {
  const now = Date.now();
  const entries = [1, 2, 3].map((minutes) =>
    entry(new Date(now - minutes * 10 * 60_000).toISOString(), { exec: 'fail' }),
  );
  assert.equal(checkDmQuota(config, entries, ownerUid, now).ok, true);
});
