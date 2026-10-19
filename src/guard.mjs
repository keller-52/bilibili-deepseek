import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './paths.mjs';

const STATE_FILE = 'guard-state.json';
const WINDOW_MS = 60 * 60 * 1000;
const MAX_NAVIGATIONS_PER_HOUR = 40;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read the persisted navigation ledger. Missing/corrupt files start empty. */
export async function readGuardState(home) {
  try {
    const parsed = JSON.parse(await readFile(path.join(home, STATE_FILE), 'utf8'));
    const navigations = Array.isArray(parsed?.navigations)
      ? parsed.navigations.map(Number).filter((value) => Number.isFinite(value) && value > 0)
      : [];
    return { navigations };
  } catch {
    return { navigations: [] };
  }
}

async function writeGuardState(home, state) {
  await mkdir(home, { recursive: true });
  const file = path.join(home, STATE_FILE);
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

/** Locate the configured kill switch (STOP by default), if it exists. */
export async function findStopFile(config, { home, root = ROOT } = {}) {
  const name = String(config?.guard?.killed_file ?? 'STOP').trim() || 'STOP';
  const safe = path.basename(name);
  const candidates = [path.join(home, safe)];
  if (path.resolve(root) !== path.resolve(home)) candidates.push(path.join(root, safe));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Throw when the operator has dropped the STOP file. */
export async function assertNotStopped(config, { home, root = ROOT } = {}) {
  const stop = await findStopFile(config, { home, root });
  if (stop) throw new Error(`急停：检测到 ${stop}，所有 B 站操作都不会执行`);
}

function recentNavigations(state, now) {
  return state.navigations.filter((ts) => ts > now - WINDOW_MS).sort((a, b) => a - b);
}

function randomJitter(range, random) {
  const low = Math.max(0, Number(range?.[0] ?? 3));
  const high = Math.max(low, Number(range?.[1] ?? 12));
  return (low + Math.floor(random() * (high - low + 1))) * 1000;
}

let queue = Promise.resolve();

/**
 * Wait for the navigation budget before opening a page. Serialised inside one
 * process so two console actions cannot both slide in under the interval.
 */
export function beforeNavigation({
  config,
  paths,
  port = 9222,
  throttle = true,
  now = Date.now(),
  random = Math.random,
  sleepFn = sleep,
  env = process.env,
} = {}) {
  if (!paths?.home) throw new Error('缺少 runtime 路径，无法执行导航限速');
  const run = queue.then(async () => {
    await assertNotStopped(config, { home: paths.home });
    const state = await readGuardState(paths.home);
    const recent = recentNavigations(state, now);
    if (recent.length >= MAX_NAVIGATIONS_PER_HOUR) {
      throw new Error(
        `导航次数已达每小时上限（${MAX_NAVIGATIONS_PER_HOUR} 次），先停一会儿再操作`,
      );
    }

    // BILI_DUTY_FAST=1 is a local development escape hatch; it never persists
    // a navigation, so it cannot exhaust the real budget.
    if (!throttle || env.BILI_DUTY_FAST === '1') {
      return { waitedMs: 0, navigationsLastHour: recent.length, throttled: false };
    }

    const minMs = Math.max(0, Number(config?.guard?.min_interval_sec ?? 20)) * 1000;
    const jitterMs = randomJitter(config?.guard?.jitter_sec, random);
    const last = recent.length ? recent[recent.length - 1] : 0;
    const target = last + minMs + jitterMs;
    const waitedMs = Math.max(0, target - now);
    if (waitedMs > 0) await sleepFn(waitedMs);

    const stamped = Date.now();
    await writeGuardState(paths.home, {
      navigations: [...recent, stamped].filter((ts) => ts > stamped - WINDOW_MS),
    });
    return { waitedMs, navigationsLastHour: recent.length + 1, throttled: true, port };
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export { MAX_NAVIGATIONS_PER_HOUR, WINDOW_MS };
