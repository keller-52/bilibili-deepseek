import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const WINDOWS_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
].filter(Boolean);

export function findChrome() {
  return WINDOWS_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

export async function fetchCdpVersion(port, timeoutMs = 1500) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`CDP 返回 HTTP ${response.status}`);
  return response.json();
}

export async function isCdpUp(port) {
  try {
    await fetchCdpVersion(port);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Launch the local Chrome with a dedicated profile and a CDP port.
 * If a CDP endpoint is already listening on the port we reuse it.
 */
export async function launchChrome({ port = 9222, profileDir, headless = true, executable } = {}) {
  if (await isCdpUp(port)) {
    const version = await fetchCdpVersion(port);
    return { reused: true, port, browser: version.Browser, executable: null };
  }

  const chrome = executable || findChrome();
  if (!chrome) {
    throw new Error('找不到 Chrome。请安装 Google Chrome，或设置环境变量 CHROME_PATH。');
  }

  await mkdir(profileDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--window-size=1280,900',
    '--lang=zh-CN',
    ...(headless ? ['--headless=new', '--disable-gpu', '--hide-scrollbars'] : []),
    'about:blank',
  ];

  const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
  child.unref();

  let exited = null;
  child.once('exit', (code) => {
    exited = code ?? -1;
  });

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(`Chrome 启动后退出了（code=${exited}）。可能是 profile 被占用，换一个端口或关闭旧窗口再试。`);
    }
    if (await isCdpUp(port)) {
      const version = await fetchCdpVersion(port);
      return { reused: false, port, browser: version.Browser, executable: chrome, headless };
    }
    await sleep(500);
  }

  throw new Error('Chrome 启动超时（25 秒内没有等到 CDP）。请确认 9222 端口未被占用。');
}
