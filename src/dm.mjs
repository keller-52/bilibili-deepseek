import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connectCdp, evaluate, goto, newPage, screenshot, sleep, waitFor } from './cdp.mjs';
import { isCdpUp } from './chrome.mjs';
import { readLoginState } from './bili.mjs';
import { getOwner, loadAllowlist } from './allowlist.mjs';
import { loadConfig } from './config.mjs';
import { appendAudit, tailAudit } from './audit.mjs';
import { runtimePaths } from './paths.mjs';
import { findStopFile } from './guard.mjs';

const LINK_PATTERN = /(https?:\/\/|www\.|b23\.tv|bili2233\.cn|\.com\/|\.cn\/)/i;
const MAX_LENGTH = 300;

export function validateDmText(text) {
  const content = String(text ?? '').trim();
  if (!content) return { ok: false, errors: ['私信内容不能为空'] };
  if (content.length > MAX_LENGTH) {
    return { ok: false, errors: [`私信不能超过 ${MAX_LENGTH} 字（当前 ${content.length}）`] };
  }
  if (LINK_PATTERN.test(content)) return { ok: false, errors: ['私信禁止包含链接'] };
  return { ok: true, content };
}

export function checkDmQuota(config, entries, ownerUid, now = Date.now()) {
  const limits = {
    perDay: Number(config?.l2?.dm_per_day ?? 10),
    perPerson: Number(config?.l2?.dm_per_person_per_day ?? 3),
    interval: Number(config?.l2?.dm_min_interval_sec ?? 300),
  };
  const done = (entries ?? [])
    .filter((entry) => entry?.action === 'dm' && entry?.exec === 'ok')
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  const today = new Date(now).toDateString();
  const todayEntries = done.filter((entry) => entry?.ts && new Date(entry.ts).toDateString() === today);
  if (todayEntries.length >= limits.perDay) {
    return { ok: false, errors: [`今天私信已达上限（${limits.perDay} 条）`] };
  }
  if (todayEntries.filter((entry) => Number(entry.target) === Number(ownerUid)).length >= limits.perPerson) {
    return { ok: false, errors: [`今天给主人发的私信已达上限（${limits.perPerson} 条）`] };
  }

  const last = done[done.length - 1];
  if (last?.ts) {
    const elapsed = (now - new Date(last.ts).getTime()) / 1000;
    if (elapsed < limits.interval) {
      return {
        ok: false,
        errors: [`距离上一条私信只有 ${Math.round(elapsed)} 秒，最小间隔 ${limits.interval} 秒`],
      };
    }
  }
  return { ok: true, limits };
}

async function clearEditor(page) {
  const hasText = await evaluate(page, "Boolean((document.querySelector('.brt-editor')?.innerText || '').trim())");
  if (!hasText) return;
  await evaluate(page, "document.querySelector('.brt-editor').focus()");
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    modifiers: 2,
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    modifiers: 2,
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
  });
  await sleep(300);
}

async function clickSendButton(page) {
  const rect = await evaluate(page, `(() => {
    const button = document.querySelector('[class*="SendBtn"]');
    if (!button) return null;
    const box = button.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`);
  if (!rect) throw new Error('找不到发送按钮');
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: rect.x,
    y: rect.y,
    button: 'left',
    clickCount: 1,
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: rect.x,
    y: rect.y,
    button: 'left',
    clickCount: 1,
  });
}

/**
 * Send one private message to the whitelisted owner through the B站 message UI.
 * Rules enforced before touching the browser: only the owner, no links, <=300
 * chars, daily/person/interval quotas from config.yaml.
 */
export async function sendOwnerDm(text, { port = 9222, dryRun = false } = {}) {
  const checked = validateDmText(text);
  if (!checked.ok) return { ok: false, errors: checked.errors };

  const allowlist = await loadAllowlist();
  const owner = getOwner(allowlist);
  if (!owner) return { ok: false, errors: ['白名单里还没有标记主人（owner）'] };

  const config = await loadConfig();
  const paths = runtimePaths(config.data);
  const stop = await findStopFile(config.data, { home: paths.home });
  if (stop) return { ok: false, errors: [`急停：检测到 ${stop}，所有 B 站操作都不会执行`], owner };
  const previous = await tailAudit(paths.audit, 200);
  const quota = checkDmQuota(config.data, previous.entries, Number(owner.uid));
  if (!quota.ok) return { ok: false, errors: quota.errors, owner };

  if (!(await isCdpUp(port))) {
    return { ok: false, errors: [`Chrome 没有以调试模式启动（端口 ${port}）`], owner };
  }

  const cdp = await connectCdp(port);
  let page = null;
  const ts = new Date().toISOString();

  try {
    const login = await readLoginState(cdp);
    if (!login.loggedIn) return { ok: false, errors: ['B 站未登录'], owner };
    if (Number(login.uid) === Number(owner.uid)) {
      return { ok: false, errors: ['登录的账号就是主人，不能给自己发私信'], owner };
    }

    page = await newPage(cdp, 'about:blank', { width: 1280, height: 900 });
    await goto(page, `https://message.bilibili.com/#/whisper/mid${owner.uid}`, { timeoutMs: 30_000 });
    const ready = await waitFor(page, "document.querySelector('.brt-editor')", { timeoutMs: 20_000 });
    if (!ready) throw new Error('私信页没有加载出输入框');

    await evaluate(page, "document.querySelector('.brt-editor').focus()");
    await clearEditor(page);
    await page.send('Input.insertText', { text: checked.content });
    await sleep(700);

    const typed = await evaluate(page, `(() => {
      const editor = document.querySelector('.brt-editor');
      const send = document.querySelector('[class*="SendBtn"]');
      return {
        text: (editor?.innerText || '').trim(),
        hasSend: Boolean(send),
        disabled: /IsDisabled/.test(String(send?.className || '')),
      };
    })()`);
    if (!typed.text) throw new Error('输入框没有收到文字');
    if (!typed.hasSend || typed.disabled) throw new Error('发送按钮不可用');

    if (dryRun) {
      await clearEditor(page);
      return { ok: true, dryRun: true, owner, loginUid: login.uid, typed };
    }

    await clickSendButton(page);

    let cleared = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(300);
      cleared = await evaluate(page, "!(document.querySelector('.brt-editor')?.innerText || '').trim()");
      if (cleared) break;
    }

    const shot = await screenshot(page);
    const shotFile = path.join(paths.home, 'dm-last.png');
    await mkdir(path.dirname(shotFile), { recursive: true });
    await writeFile(shotFile, Buffer.from(shot, 'base64'));

    await appendAudit(paths.audit, {
      ts,
      action: 'dm',
      target: Number(owner.uid),
      target_name: owner.name,
      content: checked.content,
      rule: 'pass',
      ai: 'skip-owner',
      human: 'manual',
      exec: cleared ? 'ok' : 'unknown',
      verify: cleared ? 'visible' : 'unknown',
    });

    return {
      ok: cleared,
      owner,
      loginUid: login.uid,
      verified: cleared,
      screenshot: shotFile,
      errors: cleared ? [] : ['发送后输入框没有清空，无法确认是否送达'],
    };
  } catch (error) {
    await appendAudit(paths.audit, {
      ts,
      action: 'dm',
      target: Number(owner.uid),
      target_name: owner.name,
      content: checked.content,
      rule: 'pass',
      ai: 'skip-owner',
      human: 'manual',
      exec: 'fail',
      verify: 'not-sent',
      error: error.message,
    }).catch(() => {});
    return { ok: false, owner, errors: [error.message] };
  } finally {
    if (page) await page.close();
    cdp.close();
  }
}
