import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { connectCdp, evaluate, goto, newPage, screenshot, sleep, waitFor } from './cdp.mjs';
import { isCdpUp } from './chrome.mjs';
import { readLoginState } from './bili.mjs';
import { loadConfig } from './config.mjs';
import { runtimePaths } from './paths.mjs';
import { beforeNavigation, findStopFile, readGuardState } from './guard.mjs';
import { appendDailyNote, appendWatched, readWatched } from './memory.mjs';

const SEARCH_URL = 'https://search.bilibili.com/all?keyword=';
const VIDEO_URL = 'https://www.bilibili.com/video/';
const BVID_RE = /BV[0-9A-Za-z]{10}/;
const MAX_QUERY = 50;
const MAX_SEARCH_LIMIT = 10;
const MAX_COMMENTS = 50;

const SEARCH_EXPRESSION = String.raw`(() => {
  const seen = new Set();
  const items = [];
  for (const card of document.querySelectorAll('.bili-video-card')) {
    const link = card.querySelector('.bili-video-card__info--right a[href*="/video/BV"]')
      || card.querySelector('a[href*="/video/BV"]');
    const href = link?.getAttribute('href') || '';
    const match = /\/video\/(BV[0-9A-Za-z]{10})/.exec(href);
    if (!match || seen.has(match[1])) continue;
    const titleEl = card.querySelector('.bili-video-card__info--tit');
    const title = (titleEl?.getAttribute('title') || titleEl?.innerText || '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    seen.add(match[1]);
    const owner = card.querySelector('.bili-video-card__info--owner');
    const uid = /space\.bilibili\.com\/(\d+)/.exec(owner?.getAttribute('href') || '');
    const stats = [...card.querySelectorAll('.bili-video-card__stats--item')]
      .map((el) => (el.innerText || '').trim())
      .filter(Boolean);
    items.push({
      bvid: match[1],
      title,
      author: (card.querySelector('.bili-video-card__info--author')?.innerText || '').trim(),
      authorUid: uid ? Number(uid[1]) : null,
      play: stats[0] || '',
      danmaku: stats[1] || '',
      duration: (card.querySelector('.bili-video-card__stats__duration')?.innerText || '').trim(),
      pubdate: (card.querySelector('.bili-video-card__info--date')?.innerText || '').replace(/^·\s*/, '').trim(),
      url: 'https://www.bilibili.com/video/' + match[1],
    });
  }
  return items;
})()`;

const VIDEO_EXPRESSION = String.raw`(() => {
  const pick = (selector) => {
    const el = document.querySelector(selector);
    return el ? (el.innerText || el.textContent || '').trim() : '';
  };
  const up = document.querySelector('a.up-name');
  const upUid = /space\.bilibili\.com\/(\d+)/.exec(up?.getAttribute('href') || '');
  const tags = [...document.querySelectorAll('.tag-panel a, .video-tag a')]
    .map((el) => (el.innerText || '').trim())
    .filter(Boolean);
  return {
    title: (document.querySelector('h1.video-title')?.getAttribute('title') || pick('h1.video-title')
      || document.title.replace(/_哔哩哔哩.*$/, '')).trim(),
    author: pick('a.up-name'),
    authorUid: upUid ? Number(upUid[1]) : null,
    view: pick('.view-text') || pick('.view.item'),
    danmaku: pick('.dm-text') || pick('.dm.item'),
    like: pick('.video-like-info') || pick('.video-like'),
    coin: pick('.video-coin-info') || pick('.video-coin'),
    favorite: pick('.video-fav-info') || pick('.video-fav'),
    share: pick('.video-share-info') || pick('.video-share-wrap'),
    duration: pick('.bpx-player-ctrl-time-duration'),
    pubdate: pick('.video-info-detail') || pick('.pubdate-ip-text') || pick('.pubdate'),
    desc: pick('.desc-info-text') || pick('.desc-info') || pick('.video-desc'),
    tags: tags.slice(0, 12),
    url: location.href.split('#')[0],
  };
})()`;

const HEADER_EXPRESSION = String.raw`(() => {
  const root = document.querySelector('bili-comments')?.shadowRoot;
  const header = root?.querySelector('bili-comments-header-renderer')?.shadowRoot;
  return {
    enabled: Boolean(root),
    total: (header?.querySelector('#count')?.innerText || '').trim(),
    sort: (header?.querySelector('#sort-actions')?.className || '').trim(),
  };
})()`;

const COUNT_EXPRESSION = String.raw`(() => {
  const root = document.querySelector('bili-comments')?.shadowRoot;
  return root ? root.querySelectorAll('bili-comment-thread-renderer').length : 0;
})()`;

const COMMENTS_EXPRESSION = String.raw`(() => {
  const root = document.querySelector('bili-comments')?.shadowRoot;
  if (!root) return { items: [], loaded: 0, total: '', sort: '' };
  const header = root.querySelector('bili-comments-header-renderer')?.shadowRoot;
  const likeCount = (value) => {
    const text = String(value || '').trim();
    const match = /^([\d.]+)(万)?$/.exec(text);
    if (!match) return 0;
    return Math.round(Number(match[1]) * (match[2] ? 10000 : 1));
  };
  const items = [];
  for (const thread of root.querySelectorAll('bili-comment-thread-renderer')) {
    const comment = thread.shadowRoot?.querySelector('bili-comment-renderer');
    const sr = comment?.shadowRoot;
    if (!sr) continue;
    const user = sr.querySelector('bili-comment-user-info')?.shadowRoot;
    const rich = sr.querySelector('bili-rich-text')?.shadowRoot;
    const action = sr.querySelector('bili-comment-action-buttons-renderer')?.shadowRoot;
    const replies = thread.shadowRoot?.querySelector('bili-comment-replies-renderer')?.shadowRoot;
    const text = (rich?.querySelector('#contents')?.innerText || '').replace(/\s+$/, '').trim();
    if (!text) continue;
    const replyText = (replies?.querySelector('#view-more span')?.innerText || '').trim();
    const replyMatch = /共\s*(\d+)\s*条回复/.exec(replyText);
    const uid = user?.querySelector('#user-name')?.getAttribute('data-user-profile-id');
    items.push({
      author: (user?.querySelector('#user-name a')?.textContent || '').trim(),
      authorUid: uid ? Number(uid) : null,
      text,
      pubdate: (action?.querySelector('#pubdate')?.innerText || '').trim(),
      likes: likeCount(action?.querySelector('#like #count')?.innerText),
      replies: replyMatch ? Number(replyMatch[1]) : 0,
    });
  }
  return {
    items,
    loaded: items.length,
    total: (header?.querySelector('#count')?.innerText || '').trim(),
    sort: (header?.querySelector('#sort-actions')?.className || '').trim(),
  };
})()`;

const PAGE_STATE_EXPRESSION = String.raw`(() => ({
  url: location.href,
  title: document.title,
  body: (document.body?.innerText || '').slice(0, 2000),
}))()`;

function sortExpression(label) {
  return `(() => {
    const root = document.querySelector('bili-comments')?.shadowRoot;
    const header = root?.querySelector('bili-comments-header-renderer')?.shadowRoot;
    if (!header) return false;
    const button = [...header.querySelectorAll('#sort-actions bili-text-button')]
      .find((el) => (el.innerText || '').trim() === ${JSON.stringify(label)});
    if (!button) return false;
    button.click();
    return true;
  })()`;
}

export function parseBvid(input) {
  const match = BVID_RE.exec(String(input ?? '').trim());
  return match ? match[0] : null;
}

export function normalizeQuery(value) {
  const query = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!query) return { ok: false, errors: ['搜索关键词不能为空'] };
  if (query.length > MAX_QUERY) return { ok: false, errors: [`搜索关键词不能超过 ${MAX_QUERY} 个字`] };
  return { ok: true, query };
}

export function normalizeSearchLimit(value, fallback = 5) {
  const limit = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    return { ok: false, errors: [`搜索结果条数必须是 1–${MAX_SEARCH_LIMIT} 的整数`] };
  }
  return { ok: true, limit };
}

export function normalizeCommentLimit(value, fallback = 20) {
  const limit = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_COMMENTS) {
    return { ok: false, errors: [`评论条数必须是 0–${MAX_COMMENTS} 的整数`] };
  }
  return { ok: true, limit };
}

export function normalizeOrder(value) {
  const order = String(value ?? 'hot').trim().toLowerCase();
  if (order === 'hot' || order === '最新' || order === '最热') {
    return { ok: true, order: order === '最新' ? 'new' : 'hot' };
  }
  if (order === 'new' || order === 'time') return { ok: true, order: 'new' };
  return { ok: false, errors: ['评论排序只能是 hot 或 new'] };
}

function assertPageHealthy(state, label) {
  const url = String(state?.url ?? '');
  const title = String(state?.title ?? '');
  const body = String(state?.body ?? '');
  if (/passport\.bilibili\.com\/login/.test(url)) {
    throw new Error('B 站登录态失效：页面跳到了登录页，请先在控制台扫码登录');
  }
  if (/安全验证|访问被拦截|请求过于频繁/.test(title)) {
    throw new Error(`触发 B 站验证或限流：${title}。请先停一会儿，必要时人工处理`);
  }
  if (/操作过于频繁|请求过于频繁|访问过于频繁/.test(body)) {
    throw new Error('B 站提示操作/请求过于频繁。今天先停，必要时人工处理');
  }
  if (/登录后查看\s*\d+\s*条评论/.test(body)) {
    throw new Error('B 站未登录：评论区只显示登录提示，请先在控制台扫码登录');
  }
  if (/稿件不可见|视频不存在|啥都木有|抱歉，.*不存在|404 Not Found/.test(`${title}\n${body}`)) {
    throw new Error(`${label}不可用：${title || '页面不存在'}`);
  }
}

async function captureFailure(page, paths, label) {
  try {
    const shot = await screenshot(page);
    await mkdir(paths.home, { recursive: true });
    const file = path.join(paths.home, `read-fail-${label}-${Date.now()}.png`);
    await writeFile(file, Buffer.from(shot, 'base64'));
    return file;
  } catch {
    return null;
  }
}

async function openLoginChecked(port) {
  if (!(await isCdpUp(port))) {
    throw new Error(`Chrome 没有以调试模式启动（端口 ${port}），先在控制台启动或连接 Chrome`);
  }
  const cdp = await connectCdp(port);
  try {
    const login = await readLoginState(cdp);
    if (!login.loggedIn) throw new Error('B 站未登录：请先在控制台扫码登录');
    return { cdp, login };
  } catch (error) {
    cdp.close();
    throw error;
  }
}

function closeQuietly(cdp, page) {
  return Promise.allSettled([page ? page.close() : Promise.resolve(), cdp ? Promise.resolve(cdp.close()) : Promise.resolve()]);
}

/** Read-only status used by the console and the DSH tool. */
export async function readStatus({ port = 9222 } = {}) {
  const config = await loadConfig();
  const paths = runtimePaths(config.data);
  const stop = await findStopFile(config, { home: paths.home });
  const state = await readGuardState(paths.home);
  const now = Date.now();

  let cdpUp = false;
  let login = { loggedIn: false, uid: null, expires: null };
  try {
    cdpUp = await isCdpUp(port);
    if (cdpUp) {
      const cdp = await connectCdp(port);
      try {
        login = await readLoginState(cdp);
      } finally {
        cdp.close();
      }
    }
  } catch {
    /* status must not throw */
  }

  const watched = await readWatched(paths.memory, 1).catch(() => ({
    entries: [],
    total: 0,
    missing: true,
    file: path.join(paths.memory, 'watched.jsonl'),
  }));

  return {
    ok: true,
    port,
    cdp: cdpUp,
    loggedIn: Boolean(login.loggedIn),
    uid: login.uid ?? null,
    expires: login.expires ?? null,
    stop: stop ? { file: stop } : null,
    navigationsLastHour: state.navigations.filter((ts) => ts > now - 60 * 60 * 1000).length,
    memory: {
      file: watched.file,
      total: watched.total,
      missing: Boolean(watched.missing),
      last: watched.entries?.[0] ?? null,
    },
    config: { errors: config.errors, warnings: config.warnings },
  };
}

/** Search videos by keyword through the real Chrome UI. Read-only. */
export async function searchVideos(query, { limit = 5, port = 9222, throttle = true } = {}) {
  const checkedQuery = normalizeQuery(query);
  if (!checkedQuery.ok) return { ok: false, errors: checkedQuery.errors };
  const checkedLimit = normalizeSearchLimit(limit);
  if (!checkedLimit.ok) return { ok: false, errors: checkedLimit.errors };

  const config = await loadConfig();
  const paths = runtimePaths(config.data);
  const started = Date.now();
  let cdp = null;
  let page = null;

  try {
    const session = await openLoginChecked(port);
    cdp = session.cdp;
    const nav = await beforeNavigation({ config, paths, throttle });
    page = await newPage(cdp, 'about:blank', { width: 1280, height: 1000 });
    await goto(page, `${SEARCH_URL}${encodeURIComponent(checkedQuery.query)}`, { timeoutMs: 30_000 });
    await waitFor(page, "document.querySelectorAll('.bili-video-card').length > 0", { timeoutMs: 15_000 });
    await sleep(1200);

    const state = await evaluate(page, PAGE_STATE_EXPRESSION).catch(() => null);
    if (state) assertPageHealthy(state, '搜索页');

    const raw = await evaluate(page, SEARCH_EXPRESSION).catch(() => []);
    const items = Array.isArray(raw) ? raw.slice(0, checkedLimit.limit) : [];
    return {
      ok: true,
      query: checkedQuery.query,
      url: `${SEARCH_URL}${encodeURIComponent(checkedQuery.query)}`,
      items,
      totalVisible: Array.isArray(raw) ? raw.length : 0,
      loginUid: session.login.uid,
      waitedMs: nav.waitedMs,
      tookMs: Date.now() - started,
    };
  } catch (error) {
    const shot = page ? await captureFailure(page, paths, 'search') : null;
    return {
      ok: false,
      errors: [error.message],
      screenshot: shot,
      query: checkedQuery.query,
      tookMs: Date.now() - started,
    };
  } finally {
    await closeQuietly(cdp, page);
  }
}

async function selectCommentOrder(page, order) {
  if (order !== 'new') return { changed: false, sort: 'hot' };
  const changed = await evaluate(page, sortExpression('最新')).catch(() => false);
  if (!changed) return { changed: false, sort: 'hot' };
  await waitFor(page, "(() => { const r = document.querySelector('bili-comments')?.shadowRoot; return Boolean(r?.querySelector('bili-comment-thread-renderer')); })()", {
    timeoutMs: 10_000,
  });
  await sleep(900);
  return { changed: true, sort: 'new' };
}

async function loadComments(page, limit) {
  let count = 0;
  let idle = 0;
  const maxScrolls = 24;
  for (let attempt = 0; attempt < maxScrolls && count < limit; attempt += 1) {
    count = await evaluate(page, COUNT_EXPRESSION).catch(() => 0);
    if (count >= limit) break;
    await evaluate(page, 'window.scrollBy(0, Math.round(innerHeight * 0.85))').catch(() => {});
    await sleep(850 + Math.floor(Math.random() * 350));
    const next = await evaluate(page, COUNT_EXPRESSION).catch(() => count);
    if (next <= count) idle += 1;
    else idle = 0;
    if (idle >= 3) break;
  }
  if (count < limit) {
    // One last nudge: jump to the bottom of the document, then settle.
    await evaluate(page, 'window.scrollTo(0, document.documentElement.scrollHeight)').catch(() => {});
    await sleep(1200);
  }
  const data = await evaluate(page, COMMENTS_EXPRESSION).catch(() => ({ items: [], loaded: 0, total: '', sort: '' }));
  return {...data, items: (data.items ?? []).slice(0, limit) };
}

/** Open one video, read its metadata and (optionally) comments. Read-only. */
export async function readVideo(
  input,
  { comments = 20, order = 'hot', note = '', port = 9222, throttle = true, record = true } = {},
) {
  const bvid = parseBvid(input);
  if (!bvid) return { ok: false, errors: ['需要一个 BV 号或 B 站视频链接'] };
  const checkedLimit = normalizeCommentLimit(comments);
  if (!checkedLimit.ok) return { ok: false, errors: checkedLimit.errors };
  const checkedOrder = normalizeOrder(order);
  if (!checkedOrder.ok) return { ok: false, errors: checkedOrder.errors };

  const config = await loadConfig();
  const paths = runtimePaths(config.data);
  const started = Date.now();
  let cdp = null;
  let page = null;

  try {
    const session = await openLoginChecked(port);
    cdp = session.cdp;
    const nav = await beforeNavigation({ config, paths, throttle });
    page = await newPage(cdp, 'about:blank', { width: 1280, height: 1200 });
    await goto(page, `${VIDEO_URL}${bvid}`, { timeoutMs: 30_000 });
    const gotTitle = await waitFor(page, "Boolean(document.querySelector('h1.video-title'))", { timeoutMs: 20_000 });
    await sleep(2200);

    const state = await evaluate(page, PAGE_STATE_EXPRESSION).catch(() => null);
    if (state) assertPageHealthy(state, '视频页');
    if (!gotTitle) throw new Error(`视频页没有加载出标题（${bvid}）`);

    const video = await evaluate(page, VIDEO_EXPRESSION);
    if (!video?.title) throw new Error(`没有读到视频信息（${bvid}）`);
    video.url = `${VIDEO_URL}${bvid}`;

    let commentData = { items: [], loaded: 0, total: '', sort: '' };
    if (checkedLimit.limit > 0) {
      const enabled = await waitFor(page, "Boolean(document.querySelector('bili-comments')?.shadowRoot)", { timeoutMs: 10_000 });
      if (enabled) {
        const orderResult = await selectCommentOrder(page, checkedOrder.order);
        commentData = await loadComments(page, checkedLimit.limit);
        if (orderResult.changed) commentData.sort = 'time';
      } else {
        const header = await evaluate(page, HEADER_EXPRESSION).catch(() => null);
        commentData.total = header?.total ?? '';
      }
    } else {
      const header = await evaluate(page, HEADER_EXPRESSION).catch(() => null);
      commentData.total = header?.total ?? '';
    }

    const entry = {
      bvid,
      title: video.title,
      author: video.author,
      authorUid: video.authorUid,
      duration: video.duration,
      play: video.view,
      like: video.like,
      commentsRead: commentData.items.length,
      commentPreview: commentData.items[0]?.text ?? '',
      note,
      url: video.url || `${VIDEO_URL}${bvid}`,
    };

    let memory = null;
    if (record) {
      const watched = await appendWatched(paths.memory, entry);
      const daily = await appendDailyNote(paths.memory, entry);
      memory = { watched: watched.file, note: daily.file, entry: watched.entry };
    }

    return {
      ok: true,
      bvid,
      video,
      comments: commentData.items,
      commentsTotal: commentData.total,
      commentsLoaded: commentData.loaded,
      sort: commentData.sort || 'hot',
      memory,
      loginUid: session.login.uid,
      waitedMs: nav.waitedMs,
      tookMs: Date.now() - started,
    };
  } catch (error) {
    const shot = page ? await captureFailure(page, paths, 'video') : null;
    return { ok: false, errors: [error.message], screenshot: shot, bvid, tookMs: Date.now() - started };
  } finally {
    await closeQuietly(cdp, page);
  }
}

export { MAX_QUERY, MAX_SEARCH_LIMIT, MAX_COMMENTS };
