import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function tailAudit(file, limit = 50) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: [], total: 0, invalid: 0, missing: true };
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

  const size = Math.max(1, Math.min(Number(limit) || 50, 200));
  return { entries: entries.slice(-size).reverse(), total: entries.length, invalid, missing: false };
}

/** Append one JSON line. The audit log is append-only by design. */
export async function appendAudit(file, entry) {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
}
