import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { ALLOWLIST_EXAMPLE, ALLOWLIST_FILE } from './paths.mjs';

const MAX_UID = 2_147_483_647;

/** The real allowlist is gitignored; seed it from the committed example. */
async function ensureFile(file) {
  if (file !== ALLOWLIST_FILE) return;
  try {
    await readFile(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try {
      await copyFile(ALLOWLIST_EXAMPLE, file);
    } catch {
      throw new Error(`缺少 ${ALLOWLIST_EXAMPLE}，无法初始化私信白名单`);
    }
  }
}

async function readRaw(file) {
  await ensureFile(file);
  const text = await readFile(file, 'utf8');
  return { text, json: JSON.parse(text) };
}

function normalizeEntry(input) {
  const errors = [];
  const uid = typeof input?.uid === 'string' ? Number(input.uid.trim()) : input?.uid;
  if (!Number.isInteger(uid) || uid <= 0 || uid > MAX_UID) {
    errors.push('UID 必须是正整数（B 站 UID 为数字）');
  }
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name) errors.push('昵称不能为空');
  else if (name.length > 40) errors.push('昵称不能超过 40 个字符');
  const note = typeof input?.note === 'string' ? input.note.trim() : '';
  if (note.length > 120) errors.push('备注不能超过 120 个字符');
  return { errors, entry: { uid, name, note, owner: false } };
}

export async function loadAllowlist(file = ALLOWLIST_FILE) {
  const { json } = await readRaw(file);
  return {
    comment: json._comment ?? '',
    rules: Array.isArray(json._rules) ? json._rules : [],
    allow: Array.isArray(json.allow) ? json.allow : [],
  };
}

/** The single whitelist entry flagged as the account owner (主人). */
export function getOwner(data) {
  return (data?.allow ?? []).find((row) => row.owner === true) ?? null;
}

async function writeAllowlist(file, json) {
  const text = `${JSON.stringify(json, null, 2)}\n`;
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, file);
}

export async function addAllowlistEntry(input, file = ALLOWLIST_FILE) {
  const { errors, entry } = normalizeEntry(input);
  if (errors.length) return { ok: false, errors };

  const { json } = await readRaw(file);
  const allow = Array.isArray(json.allow) ? json.allow : [];
  if (entry.uid === 0) return { ok: false, errors: ['示例条目 uid=0 必须先替换成真实 UID'] };
  if (allow.some((row) => Number(row.uid) === entry.uid)) {
    return { ok: false, errors: [`UID ${entry.uid} 已经在白名单里`] };
  }

  json.allow = [...allow.filter((row) => Number(row.uid) !== 0), entry];
  await writeAllowlist(file, json);
  return { ok: true, entry };
}

export async function removeAllowlistEntry(uid, file = ALLOWLIST_FILE) {
  const target = Number(uid);
  if (!Number.isInteger(target) || target <= 0) return { ok: false, errors: ['UID 无效'] };
  const { json } = await readRaw(file);
  const allow = Array.isArray(json.allow) ? json.allow : [];
  const row = allow.find((item) => Number(item.uid) === target);
  if (!row) return { ok: false, errors: ['白名单里没有这个 UID'] };
  if (row.owner === true) {
    return { ok: false, errors: ['这是主人，先把主人标记换给别人再移除'] };
  }
  json.allow = allow.filter((item) => Number(item.uid) !== target);
  await writeAllowlist(file, json);
  return { ok: true };
}

/** Mark exactly one whitelist entry as the owner. */
export async function setAllowlistOwner(uid, file = ALLOWLIST_FILE) {
  const target = Number(uid);
  if (!Number.isInteger(target) || target <= 0) return { ok: false, errors: ['UID 无效'] };
  const { json } = await readRaw(file);
  const allow = Array.isArray(json.allow) ? json.allow : [];
  if (!allow.some((row) => Number(row.uid) === target)) {
    return { ok: false, errors: ['这个 UID 不在白名单里，先加进来再设为主人'] };
  }
  json.allow = allow.map((row) => ({ ...row, owner: Number(row.uid) === target }));
  await writeAllowlist(file, json);
  return { ok: true, owner: json.allow.find((row) => Number(row.uid) === target) };
}
