// Minimal Chrome DevTools Protocol client (no dependencies).
// Node's built-in WebSocket talks to the browser endpoint directly.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function connectCdp(port, { timeoutMs = 5000 } = {}) {
  const version = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(timeoutMs),
  }).then((response) => {
    if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
    return response.json();
  });

  const socket = new WebSocket(version.webSocketDebuggerUrl);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接 CDP WebSocket 超时')), timeoutMs);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('连接 CDP WebSocket 失败'));
    });
  });

  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.id) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`${message.error.message}${message.error.data ? ` (${message.error.data})` : ''}`));
      else entry.resolve(message.result ?? {});
      return;
    }
    if (message.method) {
      const handlers = listeners.get(message.method);
      if (handlers) for (const handler of [...handlers]) handler(message.params, message.sessionId);
    }
  });

  socket.addEventListener('close', () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('CDP 连接已关闭'));
    }
    pending.clear();
  });

  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = (nextId += 1);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP 命令超时：${method}`));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      socket.send(JSON.stringify(payload));
    });
  }

  function on(method, handler) {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(handler);
    return () => listeners.get(method)?.delete(handler);
  }

  return {
    version,
    send,
    on,
    close() {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    },
  };
}

export async function newPage(cdp, url = 'about:blank', { width = 1280, height = 900 } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  return attachPage(cdp, targetId, { width, height });
}

/** Attach to an existing target (e.g. a login tab we keep open between polls). */
export async function attachPage(cdp, targetId, { width = 1280, height = 900 } = {}) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  const page = {
    targetId,
    sessionId,
    send: (method, params = {}) => cdp.send(method, params, sessionId),
    async close() {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    },
  };

  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return page;
}

export async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || '页面脚本执行失败');
  }
  return result.result?.value;
}

export async function waitFor(page, expression, { timeoutMs = 15_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const wrapped = `(() => { try { return Boolean(${expression}); } catch (error) { return false; } })()`;
  while (Date.now() < deadline) {
    if (await evaluate(page, wrapped).catch(() => false)) return true;
    await sleep(intervalMs);
  }
  return false;
}

export async function goto(page, url, { timeoutMs = 20_000 } = {}) {
  const result = await page.send('Page.navigate', { url });
  if (result.errorText) throw new Error(`打开页面失败：${result.errorText}`);
  await waitFor(page, "document.readyState === 'complete'", { timeoutMs });
}

export async function screenshot(page, clip) {
  const params = { format: 'png', fromSurface: true };
  if (clip) {
    params.clip = {
      x: Math.max(0, Math.round(clip.x)),
      y: Math.max(0, Math.round(clip.y)),
      width: Math.max(1, Math.round(clip.width)),
      height: Math.max(1, Math.round(clip.height)),
      scale: 1,
    };
  }
  const { data } = await page.send('Page.captureScreenshot', params);
  return data;
}

export { sleep };
