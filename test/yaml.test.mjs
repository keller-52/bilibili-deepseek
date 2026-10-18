import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyUpdates, parse, setValue } from '../src/yaml.mjs';

const CONFIG_URL = new URL('../config/config.yaml', import.meta.url);

test('parses the real config.yaml', async () => {
  const text = await readFile(CONFIG_URL, 'utf8');
  const { data, index } = parse(text);

  assert.equal(data.l1.coin_per_day, 1);
  assert.equal(data.l2.dm_per_day, 10);
  assert.equal(data.l3.enabled, false);
  assert.equal(data.review.ai_reviewer, 'independent');
  assert.deepEqual(data.schedule.windows.noon, ['12:00', '14:00']);
  assert.deepEqual(data.guard.jitter_sec, [3, 12]);
  assert.deepEqual(data.auto.allowed_actions, ['dm_owner', 'reply_owner', 'short_comment']);
  assert.equal(data.paths.home, 'runtime');
  assert.ok(index.has('l2.dm_per_day'));
});

test('updating a scalar keeps indentation and trailing comment', async () => {
  const text = await readFile(CONFIG_URL, 'utf8');
  const next = setValue(text, 'l1.coin_per_day', 2);
  const { data } = parse(next);
  assert.equal(data.l1.coin_per_day, 2);

  const line = next.split(/\r?\n/).find((row) => row.includes('coin_per_day'));
  assert.match(line, /^  coin_per_day: 2/);
  assert.match(line, /# 硬币稀缺/);
});

test('updating a flow array keeps it as a flow array', async () => {
  const text = await readFile(CONFIG_URL, 'utf8');
  const next = setValue(text, 'guard.jitter_sec', [5, 20]);
  const { data } = parse(next);
  assert.deepEqual(data.guard.jitter_sec, [5, 20]);
  assert.match(next, /jitter_sec: \[5, 20\]/);
});

test('block sequence can be rewritten in flow style', async () => {
  const text = await readFile(CONFIG_URL, 'utf8');
  const next = setValue(text, 'auto.allowed_actions', ['dm_owner', 'short_comment']);
  const { data } = parse(next);
  assert.deepEqual(data.auto.allowed_actions, ['dm_owner', 'short_comment']);
  assert.doesNotMatch(next, /^\s+- dm_owner/m);
  assert.doesNotMatch(next, /^\s+- reply_owner/m);
});

test('quote-worthy strings survive a round trip', async () => {
  const text = await readFile(CONFIG_URL, 'utf8');
  const next = setValue(text, 'paths.home', 'D:/My Workspace/runtime');
  const { data } = parse(next);
  assert.equal(data.paths.home, 'D:/My Workspace/runtime');
  assert.match(next, /home: "D:\/My Workspace\/runtime"/);
});

test('applyUpdates writes several keys at once', async () => {
  const text = await readFile(CONFIG_URL, 'utf8');
  const next = applyUpdates(text, {
    'l1.like_per_day': 5,
    'schedule.session_max_minutes': 25,
    'l2.dm_require_human': true,
  });
  const { data } = parse(next);
  assert.equal(data.l1.like_per_day, 5);
  assert.equal(data.schedule.session_max_minutes, 25);
  assert.equal(data.l2.dm_require_human, true);
});

test('unknown key is rejected', async () => {
  const text = await readFile(CONFIG_URL, 'utf8');
  assert.throws(() => setValue(text, 'l9.nope', 1), /unknown config key/);
});
