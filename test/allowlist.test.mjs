import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addAllowlistEntry, loadAllowlist, removeAllowlistEntry } from '../src/allowlist.mjs';

const ALLOWLIST_URL = new URL('./fixtures/dm-allowlist.json', import.meta.url);

async function withTempAllowlist(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bili-duty-allow-'));
  const file = path.join(dir, 'dm-allowlist.json');
  await copyFile(ALLOWLIST_URL, file);
  try {
    return await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('loads the example allowlist fixture', async () => {
  await withTempAllowlist(async (file) => {
    const data = await loadAllowlist(file);
    assert.equal(data.allow.length, 1);
    assert.equal(data.allow[0].uid, 0);
    assert.ok(data.rules.length > 0);
  });
});

test('adding a real UID replaces the placeholder', async () => {
  await withTempAllowlist(async (file) => {
    const result = await addAllowlistEntry({ uid: '12345678', name: '测试好友', note: '已知情' }, file);
    assert.equal(result.ok, true);

    const data = await loadAllowlist(file);
    assert.equal(data.allow.length, 1);
    assert.equal(data.allow[0].uid, 12345678);
    assert.equal(data.allow[0].name, '测试好友');

    const text = await readFile(file, 'utf8');
    assert.match(text, /私信白名单/); // _comment preserved
  });
});

test('duplicate UID and uid=0 are rejected', async () => {
  await withTempAllowlist(async (file) => {
    await addAllowlistEntry({ uid: 42, name: 'A' }, file);
    const duplicate = await addAllowlistEntry({ uid: 42, name: 'B' }, file);
    assert.equal(duplicate.ok, false);

    const zero = await addAllowlistEntry({ uid: 0, name: 'C' }, file);
    assert.equal(zero.ok, false);
  });
});

test('invalid UID is rejected', async () => {
  await withTempAllowlist(async (file) => {
    const result = await addAllowlistEntry({ uid: '-3', name: 'X' }, file);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /UID/);
  });
});

test('removing an entry works and is idempotent-safe', async () => {
  await withTempAllowlist(async (file) => {
    await addAllowlistEntry({ uid: 99, name: 'D' }, file);
    const removed = await removeAllowlistEntry(99, file);
    assert.equal(removed.ok, true);
    assert.equal((await loadAllowlist(file)).allow.length, 0);

    const again = await removeAllowlistEntry(99, file);
    assert.equal(again.ok, false);
  });
});
