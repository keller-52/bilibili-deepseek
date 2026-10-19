import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  assertNotStopped,
  beforeNavigation,
  findStopFile,
  readGuardState,
} from '../src/guard.mjs';

const config = {
  guard: {
    min_interval_sec: 20,
    jitter_sec: [3, 12],
    killed_file: 'STOP',
  },
};

async function tempHome() {
  return mkdtemp(path.join(os.tmpdir(), 'bili-guard-'));
}

test('STOP file is detected in the runtime home', async () => {
  const home = await tempHome();
  try {
    assert.equal(await findStopFile(config, { home }), null);
    const stop = path.join(home, 'STOP');
    await writeFile(stop, '', 'utf8');
    assert.equal(await findStopFile(config, { home }), stop);
    await assert.rejects(() => assertNotStopped(config, { home }), /急停/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('throttle=false skips waiting and does not persist a navigation', async () => {
  const home = await tempHome();
  try {
    const result = await beforeNavigation({
      config,
      paths: { home },
      throttle: false,
    });
    assert.equal(result.waitedMs, 0);
    assert.equal(result.throttled, false);
    assert.deepEqual((await readGuardState(home)).navigations, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('navigation waits for the interval and records the timestamp', async () => {
  const home = await tempHome();
  const now = Date.now();
  const waits = [];
  try {
    const first = await beforeNavigation({
      config,
      paths: { home },
      now,
      random: () => 0.5,
      sleepFn: async (ms) => waits.push(ms),
    });
    assert.equal(first.waitedMs, 0);
    assert.equal(first.throttled, true);

    const second = await beforeNavigation({
      config,
      paths: { home },
      now,
      random: () => 0.5,
      sleepFn: async (ms) => waits.push(ms),
    });
    assert.ok(second.waitedMs >= 20_000, `expected >=20s, got ${second.waitedMs}`);
    assert.equal(waits.length, 1);
    assert.equal((await readGuardState(home)).navigations.length, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('the hourly navigation cap refuses further pages', async () => {
  const home = await tempHome();
  try {
    const now = Date.now();
    await writeFile(
      path.join(home, 'guard-state.json'),
      JSON.stringify({ navigations: Array.from({ length: 40 }, (_value, index) => now - index * 1000) }),
      'utf8',
    );
    await assert.rejects(
      () => beforeNavigation({ config, paths: { home }, now, sleepFn: async () => {} }),
      /每小时上限/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('guard state ignores malformed ledger data', async () => {
  const home = await tempHome();
  try {
    await writeFile(path.join(home, 'guard-state.json'), 'not json', 'utf8');
    assert.deepEqual(await readGuardState(home), { navigations: [] });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('BILI_DUTY_FAST skips waiting but never records', async () => {
  const home = await tempHome();
  try {
    const result = await beforeNavigation({
      config,
      paths: { home },
      env: { BILI_DUTY_FAST: '1' },
      sleepFn: async () => {
        throw new Error('should not sleep');
      },
    });
    assert.equal(result.waitedMs, 0);
    assert.deepEqual((await readGuardState(home)).navigations, []);
    assert.equal((await readFile(path.join(home, 'guard-state.json'), 'utf8').catch(() => '')).length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
