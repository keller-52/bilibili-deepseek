import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ALLOWLIST_FILE,
  CHROME_PROFILE,
  CONFIG_FILE,
  ROOT,
  WEB_DIR,
  runtimePaths,
} from './paths.mjs';
import { loadConfig, savePatch } from './config.mjs';
import { PARAM_GROUPS } from './schema.mjs';
import { addAllowlistEntry, getOwner, loadAllowlist, removeAllowlistEntry, setAllowlistOwner } from './allowlist.mjs';
import { tailAudit } from './audit.mjs';
import { findChrome, fetchCdpVersion, isCdpUp, launchChrome } from './chrome.mjs';
import { attachPage, connectCdp, sleep, waitFor } from './cdp.mjs';
import { captureQr, clearLogin, fetchNickname, openLoginPage, readLoginState } from './bili.mjs';
import { sendOwnerDm } from './dm.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HOST = '127.0.0.1';
const PORT = Number(process.env.BILI_DUTY_PORT || 7801);

const state = {
  port: Number(process.env.BILI_DUTY_CDP_PORT || 9222),
  headless: true,
  loginTarget: null,
  nickname: '',
  nicknameUid: null,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

function normalizePort(value, fallback) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('端口必须是 1024–65535 之间的整数');
  }
  return port;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl / same-origin navigation
  try {
    const parsed = new URL(origin);
    if (req.headers.host) return parsed.host === req.headers.host;
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

async function quickLogin() {
  if (!(await isCdpUp(state.port))) return { cdp: false, loggedIn: false };
  const cdp = await connectCdp(state.port);
  try {
    const login = await readLoginState(cdp);
    return {
      cdp: true,
      ...login,
      nickname: login.loggedIn && state.nicknameUid === login.uid ? state.nickname : '',
    };
  } finally {
    cdp.close();
  }
}

async function chromeInfo() {
  const executable = findChrome();
  const cdp = await isCdpUp(state.port);
  let browser = null;
  if (cdp) browser = (await fetchCdpVersion(state.port).catch(() => null))?.Browser ?? null;
  return { found: Boolean(executable), path: executable, cdp, browser, port: state.port, headless: state.headless };
}

export async function buildStatus() {
  let config = { data: {}, errors: [], warnings: [] };
  try {
    config = await loadConfig();
  } catch (error) {
    config.errors = [`读取 config.yaml 失败：${error.message}`];
  }

  let allowlist = { allow: [] };
  try {
    allowlist = await loadAllowlist();
  } catch (error) {
    config.errors.push(`读取 dm-allowlist.json 失败：${error.message}`);
  }

  const paths = runtimePaths(config.data);
  const audit = await tailAudit(paths.audit, 5).catch(() => ({ entries: [], total: 0, invalid: 0 }));
  const chrome = await chromeInfo();
  const login = await quickLogin().catch(() => ({ cdp: chrome.cdp, loggedIn: false }));

  return {
    app: { version: pkg.version, name: pkg.name },
    mode: 'ui',
    chrome,
    login,
    allowlist: {
      count: allowlist.allow.length,
      placeholder: allowlist.allow.some((row) => Number(row.uid) === 0),
      owner: (() => {
        const owner = getOwner(allowlist);
        return owner ? { uid: owner.uid, name: owner.name } : null;
      })(),
    },
    audit: { total: audit.total, invalid: audit.invalid, recent: audit.entries, missing: Boolean(audit.missing) },
    config: { errors: config.errors, warnings: config.warnings, path: CONFIG_FILE },
    paths: {
      root: ROOT,
      config: CONFIG_FILE,
      allowlist: ALLOWLIST_FILE,
      profile: CHROME_PROFILE,
      runtime: paths.home,
      audit: paths.audit,
    },
  };
}

async function ensureChrome(headless) {
  if (!(await isCdpUp(state.port))) {
    return launchChrome({ port: state.port, profileDir: CHROME_PROFILE, headless });
  }
  return { reused: true, port: state.port };
}

async function closeLoginTarget(cdp) {
  if (!state.loginTarget) return;
  await cdp.send('Target.closeTarget', { targetId: state.loginTarget.targetId }).catch(() => {});
  state.loginTarget = null;
}

async function startQr({ headless = state.headless, port = state.port } = {}) {
  state.port = normalizePort(port, state.port);
  state.headless = Boolean(headless);
  const launch = await ensureChrome(state.headless);

  const cdp = await connectCdp(state.port);
  try {
    await closeLoginTarget(cdp);
    const page = await openLoginPage(cdp);
    state.loginTarget = { targetId: page.targetId, port: state.port, createdAt: Date.now() };
    const shot = await captureQr(page);
    const login = await readLoginState(cdp);
    return { image: shot.image, fullPage: shot.fullPage, login, launch };
  } finally {
    cdp.close();
  }
}

async function refreshQr() {
  if (!state.loginTarget) return startQr();
  const cdp = await connectCdp(state.loginTarget.port);
  try {
    const page = await attachPage(cdp, state.loginTarget.targetId);
    await page.send('Page.reload', { ignoreCache: true });
    await waitFor(page, "document.querySelector('.login-scan__qrcode, .qrcode-img, .login-scan-box, canvas')", { timeoutMs: 15_000 });
    await sleep(1200);
    const shot = await captureQr(page);
    const login = await readLoginState(cdp);
    return { image: shot.image, fullPage: shot.fullPage, login };
  } catch {
    state.loginTarget = null;
    return startQr();
  } finally {
    cdp.close();
  }
}

async function pollLogin({ withNickname = false } = {}) {
  if (!(await isCdpUp(state.port))) return { cdp: false, loggedIn: false };
  const cdp = await connectCdp(state.port);
  try {
    const login = await readLoginState(cdp);
    if (login.loggedIn) {
      if (withNickname && state.nicknameUid !== login.uid) {
        state.nickname = await fetchNickname(cdp, login.uid);
        state.nicknameUid = login.uid;
      }
      if (state.nicknameUid === login.uid && state.loginTarget) {
        await closeLoginTarget(cdp);
      }
    }
    return {
      cdp: true,
      ...login,
      nickname: login.loggedIn && state.nicknameUid === login.uid ? state.nickname : '',
    };
  } finally {
    cdp.close();
  }
}

async function handleApi(req, res, url) {
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, version: pkg.version });
  }

  if (req.method === 'GET' && pathname === '/api/status') {
    return sendJson(res, 200, await buildStatus());
  }

  if (req.method === 'GET' && pathname === '/api/login') {
    return sendJson(res, 200, await pollLogin({ withNickname: true }));
  }

  if (req.method === 'POST' && pathname === '/api/login/qr') {
    const body = await readJsonBody(req);
    return sendJson(res, 200, await startQr({ headless: body.headless ?? state.headless, port: body.port }));
  }

  if (req.method === 'POST' && pathname === '/api/login/refresh') {
    return sendJson(res, 200, await refreshQr());
  }

  if (req.method === 'POST' && pathname === '/api/login/logout') {
    if (!(await isCdpUp(state.port))) throw new Error('Chrome 还没有以调试模式启动');
    const cdp = await connectCdp(state.port);
    try {
      await clearLogin(cdp);
      await closeLoginTarget(cdp);
    } finally {
      cdp.close();
    }
    state.nickname = '';
    state.nicknameUid = null;
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/chrome/launch') {
    const body = await readJsonBody(req);
    state.port = normalizePort(body.port, state.port);
    state.headless = body.headless ?? state.headless;
    const launch = await ensureChrome(state.headless);
    return sendJson(res, 200, { ok: true, launch, chrome: await chromeInfo() });
  }

  if (req.method === 'POST' && pathname === '/api/chrome/attach') {
    const body = await readJsonBody(req);
    const port = normalizePort(body.port, state.port);
    if (!(await isCdpUp(port))) throw new Error(`端口 ${port} 上没有可用的 Chrome 调试接口`);
    state.port = port;
    return sendJson(res, 200, { ok: true, chrome: await chromeInfo(), login: await quickLogin() });
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    const config = await loadConfig();
    return sendJson(res, 200, {
      data: config.data,
      groups: PARAM_GROUPS,
      errors: config.errors,
      warnings: config.warnings,
      file: CONFIG_FILE,
    });
  }

  if (req.method === 'PUT' && pathname === '/api/config') {
    const body = await readJsonBody(req);
    if (!body || typeof body.patch !== 'object' || body.patch === null || Array.isArray(body.patch)) {
      return sendJson(res, 400, { error: '请求体需要 { patch: { ... } }' });
    }
    const result = await savePatch(body.patch);
    if (!result.ok) return sendJson(res, 400, { error: result.errors.join('；'), errors: result.errors, warnings: result.warnings });
    return sendJson(res, 200, { ok: true, data: result.data, changed: result.changed, warnings: result.warnings });
  }

  if (req.method === 'GET' && pathname === '/api/allowlist') {
    return sendJson(res, 200, await loadAllowlist());
  }

  if (req.method === 'POST' && pathname === '/api/allowlist') {
    const body = await readJsonBody(req);
    const result = await addAllowlistEntry(body);
    if (!result.ok) return sendJson(res, 400, { error: result.errors.join('；'), errors: result.errors });
    return sendJson(res, 200, { ok: true, entry: result.entry, ...(await loadAllowlist()) });
  }

  const removeMatch = /^\/api\/allowlist\/(\d+)$/.exec(pathname);
  if (req.method === 'DELETE' && removeMatch) {
    const result = await removeAllowlistEntry(Number(removeMatch[1]));
    if (!result.ok) return sendJson(res, 400, { error: result.errors.join('；'), errors: result.errors });
    return sendJson(res, 200, { ok: true, ...(await loadAllowlist()) });
  }

  const ownerMatch = /^\/api\/allowlist\/(\d+)\/owner$/.exec(pathname);
  if (req.method === 'POST' && ownerMatch) {
    const result = await setAllowlistOwner(Number(ownerMatch[1]));
    if (!result.ok) return sendJson(res, 400, { error: result.errors.join('；'), errors: result.errors });
    return sendJson(res, 200, { ok: true, owner: result.owner, ...(await loadAllowlist()) });
  }

  if (req.method === 'GET' && pathname === '/api/dm/owner') {
    const allowlist = await loadAllowlist();
    const owner = getOwner(allowlist);
    return sendJson(res, 200, {
      ok: true,
      available: true,
      owner: owner ? { uid: owner.uid, name: owner.name } : null,
    });
  }

  if (req.method === 'POST' && pathname === '/api/dm/owner') {
    const body = await readJsonBody(req);
    const result = await sendOwnerDm(body.content, { port: state.port });
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (req.method === 'GET' && pathname === '/api/audit') {
    const config = await loadConfig();
    const paths = runtimePaths(config.data);
    const limit = url.searchParams.get('limit');
    return sendJson(res, 200, { file: paths.audit, ...(await tailAudit(paths.audit, limit)) });
  }

  return sendJson(res, 404, { error: `未知接口：${req.method} ${pathname}` });
}

async function serveStatic(req, res, url, { allowFrame = false } = {}) {
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  let decoded;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }

  const filePath = path.resolve(WEB_DIR, decoded);
  if (!filePath.startsWith(`${WEB_DIR}${path.sep}`)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors ${allowFrame ? "'self'" : "'none'"}`,
      'Referrer-Policy': 'no-referrer',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

/**
 * Create the request handler used by both the standalone server and the DSH
 * plugin mount. `basePath` lets the same app live under `/bili-duty` when it is
 * mounted behind the DSH web server.
 */
export function createApp({ basePath = '', allowFrame = false } = {}) {
  const prefix = String(basePath).replace(/\/+$/, '');

  return async function app(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${HOST}`);
    } catch {
      return sendJson(res, 400, { error: '请求地址无效' });
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(res, 400, { error: '路径编码无效' });
    }

    if (prefix) {
      if (pathname === prefix) {
        res.writeHead(302, { Location: `${prefix}/${url.search}` });
        res.end();
        return;
      }
      if (!pathname.startsWith(`${prefix}/`)) {
        return sendJson(res, 404, { error: '未知路径' });
      }
      pathname = pathname.slice(prefix.length);
    }

    const localUrl = new URL(`${pathname}${url.search}`, `http://${HOST}`);
    try {
      if (pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && !sameOrigin(req)) {
          return sendJson(res, 403, { error: '拒绝跨站请求' });
        }
        return await handleApi(req, res, localUrl);
      }
      return await serveStatic(req, res, localUrl, { allowFrame });
    } catch (error) {
      return sendJson(res, 500, { error: error.message || String(error) });
    }
  };
}

export function createServer(options = {}) {
  return http.createServer(createApp(options));
}

export async function start() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });
  console.log(`bili-duty 控制台已启动： http://${HOST}:${PORT}`);
  console.log(`工作区： ${ROOT}`);
  console.log(`配置文件： ${CONFIG_FILE}`);
  console.log(`Chrome 调试端口： ${state.port}`);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error) => {
    console.error(`启动失败：${error.message}`);
    process.exitCode = 1;
  });
}
