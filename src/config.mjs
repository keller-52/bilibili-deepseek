import { readFile, rename, writeFile } from 'node:fs/promises';
import { parse, applyUpdates, getPath } from './yaml.mjs';
import { CONFIG_FILE } from './paths.mjs';
import { FIELDS, validatePatch, crossCheck } from './schema.mjs';

export function setPath(target, dotPath, value) {
  const keys = dotPath.split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) {
    if (node[key] == null || typeof node[key] !== 'object') node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

export async function loadConfig(file = CONFIG_FILE) {
  const text = await readFile(file, 'utf8');
  const { data } = parse(text);
  const errors = [];
  for (const field of FIELDS.values()) {
    if (getPath(data, field.path) === undefined) errors.push(`config.yaml 缺少参数：${field.path}`);
  }
  const check = crossCheck(data);
  errors.push(...check.errors);
  return { text, data, errors, warnings: check.warnings };
}

/**
 * Validate a partial patch against the on-disk config, then write it back.
 * Values are updated line-by-line so every comment survives.
 */
export async function savePatch(patch, file = CONFIG_FILE) {
  const current = await loadConfig(file);
  const { errors, warnings, patch: normalized } = validatePatch(patch);
  if (errors.length) return { ok: false, errors, warnings };

  if (!Object.keys(normalized).length) {
    return { ok: true, data: current.data, warnings, changed: [] };
  }

  const merged = structuredClone(current.data);
  for (const [dotPath, value] of Object.entries(normalized)) setPath(merged, dotPath, value);
  const check = crossCheck(merged);
  if (check.errors.length) return { ok: false, errors: check.errors, warnings: [...warnings, ...check.warnings] };

  const text = applyUpdates(current.text, normalized);
  const verify = parse(text).data;
  for (const [dotPath, value] of Object.entries(normalized)) {
    if (JSON.stringify(getPath(verify, dotPath)) !== JSON.stringify(value)) {
      return { ok: false, errors: [`写回校验失败：${dotPath}`], warnings };
    }
  }

  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, file);
  return { ok: true, data: verify, warnings: [...warnings, ...check.warnings], changed: Object.keys(normalized) };
}
