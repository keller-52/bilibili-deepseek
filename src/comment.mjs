// Comment executor (L2). It only types after the draft and human approval
// layers passed; dry-run mode never clicks 发布.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { connectCdp, evaluate, goto, newPage, screenshot, sleep, waitFor } from './cdp.mjs';
import { isCdpUp } from './chrome.mjs';
import { readLoginState } from './bili.mjs';
import { loadConfig } from './config.mjs';
import { runtimePaths } from './paths.mjs';
import { beforeNavigation } from './guard.mjs';
import { appendAudit } from './audit.mjs';
import { consumeApproval, getDraft } from './approvals.mjs';
import { guardWrite } from './write-guard.mjs';

const BVID_RE = /BV[0-9A-Za-z]{10}/;
const VIDEO_URL = 'https://www.bilibili.com/video/';

const EDITOR_EXPRESSION = String.raw`(() => {
  const root = document.querySelector('bili-comments')?.shadowRoot;
  const box = root?.querySelector('bili-comments-header-renderer')?.shadowRoot?.querySelector('bili-comment-box');
  const rich = box?.shadowRoot?.querySelector('bili-comment-rich-textarea');
  const editor = rich?.shadowRoot?.querySelector('.brt-editor');
  if (!editor) return { found: false };
  editor.scrollIntoView({ block: 'center' });
  const rect = editor.getBoundingClientRect();
  return {
    found: true,
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
    width: rect.width,
    height: rect.height,
    display: box ? getComputedStyle(box).display : '',
    value: (editor.innerText || '').trim(),
  };
})()`;

const STATE_EXPRESSION = String.raw`(() => {
  const root = document.querySelector('bili-comments')?.shadowRoot;
  const box = root?.querySelector('bili-comments-header-renderer')?.shadowRoot?.querySelector('bili-comment-box');
  const bs = box?.shadowRoot;
  const editor = bs?.querySelector('bili-comment-rich-textarea')?.shadowRoot?.querySelector('.brt-editor');
  const pub = bs?.querySelector('#pub button');
  return {
    text: (editor?.innerText || '').trim(),
    pubClass: String(pub?.className || ''),
    pubDisabled: Boolean(pub?.disabled) || pub?.getAttribute('aria-disabled') === 'true',
    hasPub: Boolean(pub),
  };
})()`;

const COMMENTS_TEXT_EXPRESSION = String.raw`(() => {
  const root = document.querySelector('bili-comments')?.shadowRoot;
  if (!root) return [];
  const out = [];
  for (const thread of root.querySelectorAll('bili-comment-thread-renderer')) {
    const comment = thread.shadowRoot?.querySelector('bili-comment-renderer');
    const rich = comment?.shadowRoot?.querySelector('bili-rich-text');
    const text = rich?.shadowRoot?.querySelector('#contents')?.innerText || '';
    if (text.trim()) out.push(text.trim());
    if (out.length >= 30) break;
  }
  return out;
})()`;

async function clickAt(page, x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function clearEditor(page) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await sleep(250);
}

async function openEditor(page) {
  const rect = await evaluate(page, EDITOR_EXPRESSION);
  if (!rect?.found) throw new Error('没有找到评论输入框：评论区可能未开放，或页面结构变了');
  if (rect.display === 'none' || rect.width < 20 || rect.height < 10) {
    throw new Error('评论输入框不可见：账号可能还不能评论（实名/等级）或评论区已关闭');
  }
  await clickAt(page, rect.x, rect.y);
  await sleep(300);
  return rect;
}

async function typeText(page, text) {
  await clearEditor(page);
  await page.send('Input.insertText', { text });
  await sleep(700);
  const state = await evaluate(page, STATE_EXPRESSION);
  const wanted = String(text).replace(/\s+/g, ' ').trim().slice(0, 20);
  const actual = String(state?.text ?? '').replace(/\s+/g, ' ').trim();
  if (!actual.includes(wanted)) {
    throw new Error('评论输入框没有收到文字');
  }
  return state;
}

async function commentVisible(page, text) {
  const wanted = String(text).replace(/\s+/g, ' ').trim().slice(0, 40);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const comments = await evaluate(page, COMMENTS_TEXT_EXPRESSION).catch(() => []);
    if (comments.some((item) => String(item).replace(/\s+/g, ' ').includes(wanted))) return true;
    await sleep(700);
  }
  return false;
}

/**
 * Type (and optionally publish) one approved comment draft.
 * `dryRun` is the default: it types, verifies and clears the box, never clicks.
 */
export async function publishComment({
  draftId,
  token,
  port = 9222,
  dryRun = true,
  draftsDir,
  throttle = true,
  now = new Date(),
} = {}) {
  const config = await loadConfig();
  const paths = runtimePaths(config.data);
  const dir = draftsDir ?? paths.drafts;
  const started = Date.now();

  const draft = await getDraft(draftId, { draftsDir: dir });
  if (!draft) return { ok: false, errors: ['草稿不存在'] };
  if (draft.action !== 'comment') {
    return { ok: false, errors: [`这个草稿不是主评论（${draft.action}）；回复执行器还没实现`] };
  }
  if (!['pending', 'approved'].includes(draft.status)) {
    return { ok: false, errors: [`草稿状态是 ${draft.status}，不能执行`] };
  }

  const bvid = BVID_RE.exec(String(draft.target?.bvid ?? ''))?.[0];
  if (!bvid) return { ok: false, errors: ['草稿缺少有效的 BV 号'] };

  // Re-run deterministic rules now, so a config change / STOP / quota change
  // between drafting and execution still stops the action.
  const rule = await guardWrite({
    action: draft.action,
    content: draft.content,
    target: draft.target,
    config: config.data,
    allowlist: undefined,
    entries: undefined,
    now,
    home: paths.home,
  });
  if (rule.verdict === 'reject') return { ok: false, errors: rule.reasons, rule };
  if (rule.verdict === 'human' && draft.status !== 'approved') {
    return { ok: false, errors: ['规则检查要求人工批准，先批准草稿再执行'], rule };
  }

  if (!(await isCdpUp(port))) return { ok: false, errors: [`Chrome 没有以调试模式启动（端口 ${port}）`], rule };

  let cdp = null;
  let page = null;
  try {
    cdp = await connectCdp(port);
    const login = await readLoginState(cdp);
    if (!login.loggedIn) return { ok: false, errors: ['B 站未登录'], rule };

    const nav = await beforeNavigation({ config: config.data, paths, throttle });
    page = await newPage(cdp, 'about:blank', { width: 1280, height: 1200 });
    await goto(page, `${VIDEO_URL}${bvid}`, { timeoutMs: 30_000 });
    const ready = await waitFor(page, "Boolean(document.querySelector('bili-comments')?.shadowRoot)", { timeoutMs: 20_000 });
    if (!ready) throw new Error('评论区没有加载出来');
    await sleep(1800);

    const rect = await openEditor(page);
    const typed = await typeText(page, rule.text ?? draft.content);

    if (dryRun) {
      await clearEditor(page);
      return {
        ok: true,
        dryRun: true,
        bvid,
        text: rule.text ?? draft.content,
        ready: Boolean(typed.text),
        waitedMs: nav.waitedMs,
        tookMs: Date.now() - started,
        rule,
      };
    }

    if (!typed.hasPub || typed.pubDisabled) throw new Error('发布按钮不可用');
    if (!/active/.test(typed.pubClass)) throw new Error('发布按钮还没有激活');

    // Consume the approval only after the page is ready and the text is typed.
    const consumed = await consumeApproval(draftId, token, { draftsDir: dir, now: new Date() });
    if (!consumed.ok) {
      await clearEditor(page);
      return { ok: false, errors: consumed.errors, rule };
    }

    const publishRect = await evaluate(page, `(() => {
      const root = document.querySelector('bili-comments')?.shadowRoot;
      const box = root?.querySelector('bili-comments-header-renderer')?.shadowRoot?.querySelector('bili-comment-box');
      const button = box?.shadowRoot?.querySelector('#pub button');
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    if (!publishRect) throw new Error('找不到发布按钮');
    await clickAt(page, publishRect.x, publishRect.y);

    let cleared = false;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await sleep(400);
      const state = await evaluate(page, STATE_EXPRESSION).catch(() => null);
      if (state && !state.text) {
        cleared = true;
        break;
      }
    }

    const visible = cleared ? await commentVisible(page, rule.text ?? draft.content) : false;
    const shot = await screenshot(page);
    await mkdir(paths.home, { recursive: true });
    const shotFile = path.join(paths.home, 'comment-last.png');
    await writeFile(shotFile, Buffer.from(shot, 'base64'));

    await appendAudit(paths.audit, {
      ts: new Date().toISOString(),
      action: 'comment',
      target: bvid,
      content: rule.text ?? draft.content,
      rule: draft.rule?.verdict ?? 'pass',
      ai: draft.ai?.verdict ?? 'human',
      human: 'approved',
      exec: cleared ? 'ok' : 'unknown',
      verify: visible ? 'visible' : 'not-found',
      draft: draftId,
    });

    return {
      ok: cleared,
      bvid,
      verified: visible,
      screenshot: shotFile,
      draft: draftId,
      rule,
      errors: cleared ? [] : ['点击发布后输入框没有清空，无法确认是否发出'],
      tookMs: Date.now() - started,
      waitedMs: nav.waitedMs,
    };
  } catch (error) {
    await appendAudit(paths.audit, {
      ts: new Date().toISOString(),
      action: 'comment',
      target: bvid,
      content: rule.text ?? draft.content,
      rule: draft.rule?.verdict ?? 'pass',
      ai: draft.ai?.verdict ?? 'human',
      human: 'approved',
      exec: 'fail',
      verify: 'not-sent',
      error: error.message,
      draft: draftId,
    }).catch(() => {});
    return { ok: false, bvid, errors: [error.message], rule, tookMs: Date.now() - started };
  } finally {
    if (page) await page.close().catch(() => {});
    cdp?.close();
  }
}
