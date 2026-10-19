// Local review queue and one-time human approval tokens.
//
// Drafts are plain JSON files under runtime/drafts (gitignored). Approving a
// draft mints a short-lived token; only its SHA-256 hash is stored. The token is
// consumed once by the executor and never reaches the model.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ID_RE = /^draft-[a-z0-9]+-[a-f0-9]{6}$/;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const STATUSES = new Set(['pending', 'approved', 'rejected', 'used']);

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function newId(now, random = randomBytes) {
  return `draft-${now.getTime().toString(36)}-${random(3).toString('hex')}`;
}

function publicDraft(draft) {
  if (!draft) return null;
  const approval = draft.approval
    ? {
        expiresAt: draft.approval.expiresAt,
        usedAt: draft.approval.usedAt ?? null,
        approvedAt: draft.approval.approvedAt ?? null,
      }
    : null;
  return { ...draft, approval };
}

function validId(id) {
  return ID_RE.test(String(id ?? ''));
}

async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

async function readDraftFile(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !validId(parsed.id)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function createDraft(
  { action, target = {}, content = '', rule = null, ai = null, meta = {} } = {},
  { draftsDir = 'runtime/drafts', now = new Date(), random = randomBytes } = {},
) {
  const text = String(content ?? '').trim();
  if (!text) return { ok: false, errors: ['草稿内容不能为空'] };
  if (!action) return { ok: false, errors: ['缺少动作类型'] };
  const id = newId(now, random);
  const draft = {
    id,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    action: String(action),
    target,
    content: text,
    rule,
    ai,
    status: 'pending',
    approval: null,
    meta: meta && typeof meta === 'object' ? meta : {},
    history: [{ ts: now.toISOString(), event: 'created' }],
  };
  const file = path.join(draftsDir, `${id}.json`);
  await atomicWrite(file, draft);
  return { ok: true, draft: publicDraft(draft), file };
}

export async function getDraft(id, { draftsDir = 'runtime/drafts' } = {}) {
  if (!validId(id)) return null;
  return readDraftFile(path.join(draftsDir, `${id}.json`));
}

export async function listDrafts({ draftsDir = 'runtime/drafts', status = 'pending', limit = 20 } = {}) {
  let names = [];
  try {
    names = await readdir(draftsDir);
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: [], total: 0, missing: true };
    throw error;
  }
  const drafts = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const draft = await readDraftFile(path.join(draftsDir, name));
    if (draft && STATUSES.has(draft.status)) drafts.push(draft);
  }
  drafts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const filtered = status === 'all' ? drafts : drafts.filter((draft) => draft.status === status);
  const size = Math.max(1, Math.min(Number(limit) || 20, 100));
  return {
    entries: filtered.slice(0, size).map(publicDraft),
    total: filtered.length,
    missing: false,
  };
}

export async function approveDraft(id, { draftsDir = 'runtime/drafts', now = new Date(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const draft = await getDraft(id, { draftsDir });
  if (!draft) return { ok: false, errors: ['草稿不存在'] };
  if (draft.status !== 'pending') return { ok: false, errors: [`草稿状态是 ${draft.status}，不能批准`] };
  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(now.getTime() + Math.max(30_000, Number(ttlMs) || DEFAULT_TTL_MS)).toISOString();
  const updated = {
    ...draft,
    status: 'approved',
    updatedAt: now.toISOString(),
    approval: { tokenHash: hashToken(token), approvedAt: now.toISOString(), expiresAt, usedAt: null },
    history: [...(draft.history ?? []), { ts: now.toISOString(), event: 'approved' }],
  };
  await atomicWrite(path.join(draftsDir, `${id}.json`), updated);
  return { ok: true, token, draft: publicDraft(updated) };
}

export async function rejectDraft(id, { draftsDir = 'runtime/drafts', now = new Date(), reason = '' } = {}) {
  const draft = await getDraft(id, { draftsDir });
  if (!draft) return { ok: false, errors: ['草稿不存在'] };
  if (!['pending', 'approved'].includes(draft.status)) return { ok: false, errors: [`草稿状态是 ${draft.status}，不能拒绝`] };
  const updated = {
    ...draft,
    status: 'rejected',
    updatedAt: now.toISOString(),
    approval: null,
    history: [...(draft.history ?? []), { ts: now.toISOString(), event: 'rejected', reason: String(reason ?? '').slice(0, 200) }],
  };
  await atomicWrite(path.join(draftsDir, `${id}.json`), updated);
  return { ok: true, draft: publicDraft(updated) };
}

/**
 * Verify and consume a one-time approval token. Returns the draft with status
 * `used`; the caller must execute only after this succeeds.
 */
export async function consumeApproval(id, token, { draftsDir = 'runtime/drafts', now = new Date() } = {}) {
  const draft = await getDraft(id, { draftsDir });
  if (!draft) return { ok: false, errors: ['草稿不存在'] };
  if (draft.status !== 'approved' || !draft.approval?.tokenHash) {
    return { ok: false, errors: [`草稿状态是 ${draft.status}，没有可用的批准令牌`] };
  }
  if (draft.approval.usedAt) return { ok: false, errors: ['批准令牌已经用过'] };
  if (new Date(draft.approval.expiresAt).getTime() <= now.getTime()) {
    return { ok: false, errors: ['批准令牌已过期（5 分钟有效）'] };
  }
  const expected = Buffer.from(draft.approval.tokenHash, 'hex');
  const actual = Buffer.from(hashToken(token), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, errors: ['批准令牌不匹配'] };
  }
  const updated = {
    ...draft,
    status: 'used',
    updatedAt: now.toISOString(),
    approval: { ...draft.approval, usedAt: now.toISOString() },
    history: [...(draft.history ?? []), { ts: now.toISOString(), event: 'used' }],
  };
  await atomicWrite(path.join(draftsDir, `${id}.json`), updated);
  return { ok: true, draft: publicDraft(updated) };
}

export { DEFAULT_TTL_MS, STATUSES };
