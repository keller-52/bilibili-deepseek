import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, savePatch } from '../src/config.mjs';
import { crossCheck, validatePatch } from '../src/schema.mjs';

const CONFIG_URL = new URL('../config/config.yaml', import.meta.url);

test('validatePatch rejects out-of-range and unknown values', () => {
  const result = validatePatch({
    'l1.like_per_day': 9999,
    'schedule.windows.noon': ['25:00', '14:00'],
    'nope.key': true,
  });
  assert.equal(result.errors.length, 3);
});

test('validatePatch accepts a good partial patch', () => {
  const result = validatePatch({
    'l1.like_per_day': 12,
    'schedule.windows.night': ['19:00', '08:00'],
    'auto.allowed_actions': ['dm_owner'],
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.patch['schedule.windows.night'], ['19:00', '08:00']);
});

test('locked safety switches cannot be turned off', () => {
  const result = validatePatch({
    'l2.dm_allow_links': true,
    'l3.dynamic_require_human': false,
    'review.rule_engine': false,
  });
  assert.equal(result.errors.length, 3);
});

test('crossCheck catches hard-constraint violations in the file', () => {
  const base = loadConfigFixture();
  const { errors } = crossCheck({
    ...base,
    l2: { ...base.l2, dm_allow_links: true },
    review: { ...base.review, rule_engine: false },
  });
  assert.ok(errors.some((line) => line.includes('dm_allow_links')));
  assert.ok(errors.some((line) => line.includes('rule_engine')));
});

function loadConfigFixture() {
  return {
    l1: { like_per_day: 20, coin_per_day: 1, favorite_per_day: 10 },
    l2: {
      comment_per_day: 3,
      reply_per_day: 10,
      total_per_day: 10,
      dm_allowlist_only: true,
      dm_allow_links: false,
    },
    l3: { enabled: false, dynamic_require_human: true },
    review: { rule_engine: true, human_required: true },
    auto: { enabled: false, min_clean_days: 14, audit_sample_rate: 0.2 },
  };
}

test('savePatch writes a temporary copy without losing comments', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bili-duty-config-'));
  const file = path.join(dir, 'config.yaml');
  await copyFile(CONFIG_URL, file);

  try {
    const result = await savePatch({ 'l1.coin_per_day': 2, 'l2.dm_require_human': true }, file);
    assert.equal(result.ok, true, result.errors?.join('；'));

    const text = await readFile(file, 'utf8');
    assert.match(text, /coin_per_day: 2/);
    assert.match(text, /# 硬币稀缺/);
    assert.match(text, /dm_require_human: true/);

    const reloaded = await loadConfig(file);
    assert.equal(reloaded.data.l1.coin_per_day, 2);
    assert.equal(reloaded.data.l2.dm_require_human, true);
    assert.deepEqual(reloaded.errors, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('savePatch refuses a patch that would break a hard constraint', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bili-duty-config-'));
  const file = path.join(dir, 'config.yaml');
  await copyFile(CONFIG_URL, file);
  try {
    const result = await savePatch({ 'review.rule_engine': false }, file);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
