// Local AI reviewer configuration, editable from the control panel.
//
// The API key lives in config/reviewer.local.json (gitignored) and is never
// returned by the HTTP API. Environment variables remain a fallback for
// headless / standalone use.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR } from './paths.mjs';
import { createHttpReviewerTransport } from './reviewer.mjs';

export const REVIEWER_FILE = path.join(CONFIG_DIR, 'reviewer.local.json');
export const DEFAULT_MODEL = 'deepseek-chat';
const MAX_KEY = 4096;
const MAX_ENDPOINT = 500;
const MAX_MODEL = 120;

function envConfig(env = process.env) {
  const endpoint = String(env.BILI_REVIEW_API_URL || (env.BILI_REVIEW_API_KEY ? 'https://api.deepseek.com/chat/completions' : '')).trim();
  return {
    endpoint,
    model: String(env.BILI_REVIEW_MODEL || DEFAULT_MODEL).trim(),
    apiKey: String(env.BILI_REVIEW_API_KEY || '').trim(),
    source: endpoint ? 'env' : 'none',
  };
}

function normalizeEndpoint(value) {
  const endpoint = String(value ?? '').trim();
  if (!endpoint) return { ok: false, errors: ['审核 API 地址不能为空'] };
  if (endpoint.length > MAX_ENDPOINT) return { ok: false, errors: ['审核 API 地址太长'] };
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, errors: ['审核 API 地址不是合法 URL'] };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, errors: ['审核 API 地址只支持 http/https'] };
  }
  return { ok: true, endpoint: url.toString() };
}

function normalizeModel(value) {
  const model = String(value ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  if (model.length > MAX_MODEL) return { ok: false, errors: ['模型名太长'] };
  return { ok: true, model };
}

export async function loadReviewerConfig({ file = REVIEWER_FILE, env = process.env } = {}) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    const endpoint = String(parsed?.endpoint ?? '').trim();
    if (endpoint) {
      return {
        endpoint,
        model: String(parsed?.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL,
        apiKey: String(parsed?.apiKey ?? '').trim(),
        source: 'file',
        file,
      };
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      return { ...envConfig(env), file, error: `读取审核配置失败：${error.message}` };
    }
    if (error instanceof SyntaxError) {
      const fallback = envConfig(env);
      return { ...fallback, file, error: '审核配置文件不是合法 JSON，已回退到环境变量' };
    }
  }
  return { ...envConfig(env), file };
}

/** Public status: never includes the API key. */
export async function reviewerStatus({ file = REVIEWER_FILE, env = process.env } = {}) {
  const config = await loadReviewerConfig({ file, env });
  let endpointHost = '';
  if (config.endpoint) {
    try {
      endpointHost = new URL(config.endpoint).host;
    } catch {
      endpointHost = '';
    }
  }
  return {
    mode: config.endpoint ? 'http' : 'dry-run',
    endpoint: config.endpoint,
    endpointHost,
    model: config.model,
    hasKey: Boolean(config.apiKey),
    source: config.source,
    file: config.file,
    ...(config.error ? { error: config.error } : {}),
  };
}

export async function saveReviewerConfig(
  { endpoint, model, apiKey } = {},
  { file = REVIEWER_FILE, now = new Date() } = {},
) {
  const checkedEndpoint = normalizeEndpoint(endpoint);
  if (!checkedEndpoint.ok) return { ok: false, errors: checkedEndpoint.errors };
  const checkedModel = normalizeModel(model);
  if (!checkedModel.ok) return { ok: false, errors: checkedModel.errors };

  const existing = await loadReviewerConfig({ file, env: {} });
  let key = String(apiKey ?? '').trim();
  if (!key && existing.source === 'file') key = existing.apiKey;
  if (key.length > MAX_KEY) return { ok: false, errors: ['API key 太长'] };

  const value = {
    endpoint: checkedEndpoint.endpoint,
    model: checkedModel.model,
    apiKey: key,
    updatedAt: now.toISOString(),
  };
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, file);
  return { ok: true, status: await reviewerStatus({ file, env: {} }), replacedKey: !apiKey && Boolean(key) };
}

export async function deleteReviewerConfig({ file = REVIEWER_FILE } = {}) {
  await rm(file, { force: true });
  return { ok: true, status: await reviewerStatus({ file, env: {} }) };
}

/** Resolve a fresh transport for each review so UI changes apply immediately. */
export async function resolveReviewerTransport({ file = REVIEWER_FILE, env = process.env, fetchImpl } = {}) {
  const config = await loadReviewerConfig({ file, env });
  if (!config.endpoint) return null;
  return createHttpReviewerTransport({
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    model: config.model,
    fetchImpl,
  });
}

export { MAX_ENDPOINT, MAX_KEY, MAX_MODEL };
