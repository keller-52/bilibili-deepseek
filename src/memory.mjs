import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_TITLE = 200;
const MAX_NOTE = 500;
const MAX_PREVIEW = 300;

function clip(value, limit) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function memoryDate(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function memoryClock(now = new Date()) {
  return now.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

/** One line in `runtime/memory/watched.jsonl`. */
export function normalizeWatchedEntry(entry, now = new Date()) {
  const bvid = String(entry.bvid ?? '').trim();
  return {
    ts: entry.ts ?? now.toISOString(),
    bvid,
    title: clip(entry.title, MAX_TITLE),
    author: clip(entry.author, 80),
    authorUid: entry.authorUid == null ? null : Number(entry.authorUid),
    duration: clip(entry.duration, 20),
    play: clip(entry.play, 20),
    like: clip(entry.like, 20),
    commentsRead: Math.max(0, Number(entry.commentsRead) || 0),
    commentPreview: clip(entry.commentPreview, MAX_PREVIEW),
    note: clip(entry.note, MAX_NOTE),
    url: String(entry.url ?? (bvid ? `https://www.bilibili.com/video/${bvid}` : '')),
  };
}

export async function appendWatched(memoryDir, entry, now = new Date()) {
  const normalized = normalizeWatchedEntry(entry, now);
  await mkdir(memoryDir, { recursive: true });
  const file = path.join(memoryDir, 'watched.jsonl');
  await appendFile(file, `${JSON.stringify(normalized)}\n`, 'utf8');
  return { file, entry: normalized };
}

export async function readWatched(memoryDir, limit = 20) {
  const file = path.join(memoryDir, 'watched.jsonl');
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: [], total: 0, invalid: 0, missing: true, file };
    throw error;
  }

  let invalid = 0;
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      invalid += 1;
    }
  }
  const size = Math.max(1, Math.min(Number(limit) || 20, 100));
  return { entries: entries.slice(-size).reverse(), total: entries.length, invalid, missing: false, file };
}

/**
 * Append a human-readable bullet to `runtime/memory/notes/YYYY-MM-DD.md`.
 * Notes are a reading log, not a public post; they never leave this machine.
 */
export async function appendDailyNote(memoryDir, entry, now = new Date()) {
  const date = memoryDate(now);
  const dir = path.join(memoryDir, 'notes');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${date}.md`);

  let prefix = '';
  try {
    await readFile(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    prefix = `# ${date} 看过\n\n`;
  }

  const title = clip(entry.title, MAX_TITLE) || entry.bvid || '（未命名视频）';
  const url = entry.url || (entry.bvid ? `https://www.bilibili.com/video/${entry.bvid}` : '');
  const facts = [
    entry.author ? `UP ${clip(entry.author, 80)}` : '',
    entry.duration ? clip(entry.duration, 20) : '',
    entry.commentsRead ? `读了 ${Number(entry.commentsRead)} 条评论` : '',
  ].filter(Boolean);

  let bullet = `- ${memoryClock(now)} [${title}](${url})`;
  if (facts.length) bullet += ` · ${facts.join(' · ')}`;
  bullet += '\n';
  if (entry.commentPreview) bullet += `  > ${clip(entry.commentPreview, MAX_PREVIEW)}\n`;
  if (entry.note) bullet += `  - 笔记：${clip(entry.note, MAX_NOTE)}\n`;

  await appendFile(file, `${prefix}${bullet}\n`, 'utf8');
  return { file, date };
}

/** Used by the self-check and tests to seed an empty memory directory. */
export async function ensureMemory(memoryDir) {
  await mkdir(memoryDir, { recursive: true });
  const file = path.join(memoryDir, 'watched.jsonl');
  try {
    await readFile(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(file, '', 'utf8');
  }
  return file;
}
