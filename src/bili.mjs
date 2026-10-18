import { evaluate, goto, newPage, screenshot, sleep, waitFor } from './cdp.mjs';

const BILI_DOMAIN = /(^|\.)bilibili\.com$/;
const LOGIN_URL = 'https://passport.bilibili.com/login';

const LOGIN_ORIGINS = [
  'https://www.bilibili.com',
  'https://passport.bilibili.com',
  'https://space.bilibili.com',
  'https://message.bilibili.com',
  'https://t.bilibili.com',
  'https://search.bilibili.com',
];

function biliCookies(cookies) {
  return cookies.filter((cookie) => BILI_DOMAIN.test(String(cookie.domain ?? '').replace(/^\./, '')));
}

/** Read the B站 login state from Chrome cookies (no API calls). */
export async function readLoginState(cdp) {
  const { cookies = [] } = await cdp.send('Storage.getCookies');
  const mine = biliCookies(cookies);
  const pick = (name) => mine.find((cookie) => cookie.name === name);
  const sess = pick('SESSDATA');
  const uidCookie = pick('DedeUserID');
  const loggedIn = Boolean(sess?.value && uidCookie?.value);

  return {
    loggedIn,
    uid: loggedIn ? Number(uidCookie.value) : null,
    expires: sess && sess.expires > 0 ? new Date(sess.expires * 1000).toISOString() : null,
    hasBiliJct: Boolean(pick('bili_jct')?.value),
    cookieCount: mine.length,
  };
}

export async function openLoginPage(cdp) {
  const page = await newPage(cdp, 'about:blank');
  await goto(page, LOGIN_URL, { timeoutMs: 25_000 });
  await waitFor(page, "document.querySelector('.login-scan__qrcode, .qrcode-img, .login-scan-box, canvas')", {
    timeoutMs: 20_000,
  });
  await sleep(1200);
  return page;
}

const QR_RECT_EXPRESSION = `(() => {
  const selectors = [
    '.login-scan__qrcode img',
    '.login-scan__qrcode',
    'img[src^="data:image"]',
    '.qrcode-img img',
    '.qrcode-img',
    '.login-scan-box canvas',
    '.login-scan-box',
    '.scan-code img',
    'canvas',
  ];
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (rect.width >= 100 && rect.height >= 100 && rect.top < innerHeight && rect.left < innerWidth) {
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, selector };
      }
    }
  }
  return null;
})()`;

/** Screenshot the QR code area (or the viewport when it cannot be located). */
export async function captureQr(page) {
  const rect = await evaluate(page, QR_RECT_EXPRESSION).catch(() => null);
  let clip = null;
  if (rect) {
    clip = {
      x: Math.max(0, rect.x - 12),
      y: Math.max(0, rect.y - 12),
      width: rect.width + 24,
      height: rect.height + 24,
    };
  }
  const data = await screenshot(page, clip);
  return { image: `data:image/png;base64,${data}`, rect, fullPage: !rect };
}

export async function fetchNickname(cdp, uid) {
  const page = await newPage(cdp, 'about:blank');
  try {
    await goto(page, `https://space.bilibili.com/${uid}`, { timeoutMs: 20_000 });
    await sleep(1500);
    const title = String((await evaluate(page, 'document.title')) ?? '');
    const name = title.split('的个人空间')[0].replace(/-哔哩哔哩.*$/, '').trim();
    return name && name !== '哔哩哔哩' ? name : '';
  } catch {
    return '';
  } finally {
    await page.close();
  }
}

export async function clearLogin(cdp) {
  for (const origin of LOGIN_ORIGINS) {
    await cdp
      .send('Storage.clearDataForOrigin', { origin, storageTypes: 'cookies' })
      .catch(() => {});
  }
}
