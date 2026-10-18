const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// Works both standalone (`/`) and mounted under the DSH web server
// (`/bili-duty/`): every API call is resolved relative to the current page.
const API_ROOT = new URL('api/', document.baseURI);
const EMBED = new URLSearchParams(window.location.search).get('embed') === '1';
if (EMBED) document.documentElement.classList.add('embed');

const state = {
  status: null,
  config: null,
  allowlist: null,
  audit: null,
  view: 'overview',
  qrTimer: null,
  statusTimer: null,
  lastQrImage: '',
};

const VIEW_META = {
  overview: { title: '概览', sub: '账号运行前的准备：登录、白名单、参数。' },
  login: { title: '登录', sub: '扫码登录，或读取专用 Chrome 里已有的登录态。' },
  allowlist: { title: '私信白名单', sub: '只有名单里的人能收到 AI 私信。' },
  params: { title: '参数', sub: '配额、调度、审核、风控。默认值刻意保守。' },
  audit: { title: '审计', sub: '只追加的运行记录，用来复盘每一次动作。' },
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

let toastTimer = null;
function toast(message, kind = '') {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.className = 'toast';
  }, 4200);
}

async function api(path, options = {}) {
  const response = await fetch(new URL(path, API_ROOT), {
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    ...options,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = { error: `HTTP ${response.status}` };
  }
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label ?? '处理中…';
    button.disabled = true;
  } else {
    if (button.dataset.label) button.textContent = button.dataset.label;
    button.disabled = false;
  }
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

function go(view) {
  if (!VIEW_META[view]) return;
  state.view = view;
  $$('.nav button').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  $$('.view').forEach((section) => section.classList.toggle('hidden', section.id !== `view-${view}`));
  $('#view-title').textContent = VIEW_META[view].title;
  $('#view-sub').textContent = VIEW_META[view].sub;
  if (view === 'audit') loadAudit();
  if (view === 'params') loadConfig();
  if (view === 'allowlist') loadAllowlist();
}

function statusPills(chrome, login) {
  const chromePill = $('#pill-chrome');
  chromePill.className = 'pill';
  if (!chrome.found) {
    chromePill.classList.add('bad');
    chromePill.innerHTML = '<i class="dot"></i>Chrome · 没找到';
  } else if (chrome.cdp) {
    chromePill.classList.add('ok');
    chromePill.innerHTML = `<i class="dot"></i>Chrome · 已连接 ${esc(chrome.port)}`;
  } else {
    chromePill.classList.add('warn');
    chromePill.innerHTML = `<i class="dot"></i>Chrome · 未启动`;
  }

  const loginPill = $('#pill-login');
  loginPill.className = 'pill';
  if (login?.loggedIn) {
    loginPill.classList.add('ok');
    loginPill.innerHTML = `<i class="dot"></i>已登录 · UID ${esc(login.uid)}`;
  } else {
    loginPill.classList.add('warn');
    loginPill.innerHTML = '<i class="dot"></i>未登录';
  }
}

function renderOverview(status) {
  const { chrome, login, allowlist, audit, paths, config } = status;

  statusPills(chrome, login);

  $('#stat-chrome').textContent = chrome.cdp ? '已连接' : chrome.found ? '未启动' : '没找到';
  $('#stat-chrome-sub').textContent = chrome.cdp
    ? `${chrome.browser ?? 'Chrome'} · 端口 ${chrome.port}`
    : chrome.found
      ? '点「去登录」启动专用 Chrome'
      : '请安装 Chrome 或设置 CHROME_PATH';

  $('#stat-login').textContent = login?.loggedIn ? login.nickname || `UID ${login.uid}` : '未登录';
  $('#stat-login-sub').textContent = login?.loggedIn
    ? login.expires
      ? `Cookie 到期 ${formatTime(login.expires)}`
      : '已读取到登录 Cookie'
    : '扫码或读取已有登录态';

  $('#stat-allow').textContent = `${allowlist.count} 人`;
  $('#stat-allow-sub').textContent = allowlist.owner
    ? `主人：${allowlist.owner.name}`
    : allowlist.placeholder
      ? '仍是示例 UID 0，请替换'
      : '只发给知情好友';

  $('#stat-audit').textContent = `${audit.total} 条`;
  $('#stat-audit-sub').textContent = audit.missing ? '还没有审计文件' : 'runtime/audit';

  const warnings = [];
  for (const error of config.errors) warnings.push({ kind: 'bad', text: error });
  for (const warning of config.warnings) warnings.push({ kind: 'warn', text: warning });
  if (!chrome.found) warnings.push({ kind: 'bad', text: '没有找到 Chrome，登录和 UI 操作都无法进行。' });
  if (allowlist.placeholder) warnings.push({ kind: 'warn', text: '私信白名单还是示例 UID 0：先替换成真实 UID，或先保持私信关闭。' });
  if (!allowlist.owner) warnings.push({ kind: 'warn', text: '白名单还没有标记主人：评论 @ 规则会拒绝，私信也发不出去。' });
  const panel = $('#warnings-panel');
  panel.hidden = warnings.length === 0;
  $('#warnings-list').innerHTML = warnings
    .map((warning) => `<li class="${warning.kind === 'bad' ? 'bad' : ''}">${esc(warning.text)}</li>`)
    .join('');

  const pathRows = [
    ['工作区', paths.root],
    ['配置文件', paths.config],
    ['白名单', paths.allowlist],
    ['Chrome Profile', paths.profile],
    ['运行数据', paths.runtime],
    ['审计文件', paths.audit],
  ];
  $('#path-list').innerHTML = pathRows
    .map(([label, value]) => `<div><dt>${esc(label)}</dt><dd title="${esc(value)}">${esc(value)}</dd></div>`)
    .join('');

  renderAuditTable($('#mini-audit'), audit.recent, true);
  updateLoginCard(login ?? {});
}

function renderAuditTable(table, entries, compact = false) {
  if (!entries || !entries.length) {
    table.innerHTML = '<tbody><tr><td class="empty">还没有审计记录。所有写操作都会在批准后写入这里。</td></tr></tbody>';
    return;
  }
  const head = compact
    ? '<thead><tr><th>时间</th><th>动作</th><th>目标</th><th>结果</th></tr></thead>'
    : '<thead><tr><th>时间</th><th>动作</th><th>目标</th><th>规则</th><th>AI</th><th>人工</th><th>执行</th><th>核验</th><th>内容</th></tr></thead>';
  const rows = entries
    .map((entry) => {
      const time = esc(formatTime(entry.ts));
      const action = esc(entry.action ?? '—');
      const target = esc(entry.target ?? '—');
      if (compact) {
        const result = esc(entry.result ?? entry.exec ?? entry.verify ?? '—');
        return `<tr><td>${time}</td><td>${action}</td><td>${target}</td><td>${result}</td></tr>`;
      }
      return `<tr>
        <td>${time}</td><td>${action}</td><td>${target}</td>
        <td>${esc(entry.rule ?? '—')}</td><td>${esc(entry.ai ?? '—')}</td>
        <td>${esc(entry.human ?? '—')}</td><td>${esc(entry.exec ?? '—')}</td>
        <td>${esc(entry.verify ?? '—')}</td>
        <td class="muted">${esc(entry.content ?? '')}</td>
      </tr>`;
    })
    .join('');
  table.innerHTML = `${head}<tbody>${rows}</tbody>`;
}

function updateLoginCard(login) {
  const node = $('#login-state');
  const loggedIn = Boolean(login?.loggedIn);
  node.textContent = loggedIn ? '已登录' : login?.cdp === false ? 'Chrome 未启动' : '未登录';
  node.className = `login-state ${loggedIn ? 'ok' : ''}`;
  $('#login-uid').textContent = login?.uid ?? '—';
  $('#login-name').textContent = login?.nickname || '—';
  $('#login-expires').textContent = login?.expires ? formatTime(login.expires) : '—';
}

function showQr(image) {
  state.lastQrImage = image;
  const img = $('#qr-image');
  img.src = image;
  img.hidden = false;
  $('#qr-placeholder').hidden = true;
  $('#qr-hint').textContent = '二维码已加载：手机 B 站扫码，确认时选「记住我 / 长期」。状态每 2.5 秒自动检查。';
}

function stopLoginPolling() {
  clearInterval(state.qrTimer);
  state.qrTimer = null;
}

function startLoginPolling() {
  stopLoginPolling();
  state.qrTimer = setInterval(async () => {
    try {
      const login = await api('login');
      updateLoginCard(login);
      if (login.loggedIn) {
        stopLoginPolling();
        $('#qr-hint').textContent = '登录成功，登录态已写入专用 Chrome profile。';
        toast('登录成功', 'ok');
        await loadStatus();
      } else if (login.cdp === false) {
        stopLoginPolling();
        $('#qr-hint').textContent = 'Chrome 已退出，请重新启动二维码。';
      }
    } catch (error) {
      stopLoginPolling();
      $('#qr-hint').textContent = `检查登录态失败：${error.message}`;
    }
  }, 2500);
}

async function startQr() {
  const button = $('#btn-qr');
  setBusy(button, true, '启动 Chrome…');
  try {
    const headless = !$('#login-headful').checked;
    const data = await api('login/qr', { method: 'POST', body: JSON.stringify({ headless }) });
    showQr(data.image);
    if (data.launch && data.launch.reused === false) toast('已启动专用 Chrome', 'ok');
    if (data.login?.loggedIn) {
      toast('这个 profile 已经登录过了', 'ok');
      await loadStatus();
    } else {
      startLoginPolling();
    }
    $('#attach-port').value = String(state.status?.chrome?.port ?? 9222);
  } catch (error) {
    toast(error.message, 'bad');
    $('#qr-hint').textContent = error.message;
  } finally {
    setBusy(button, false);
  }
}

async function refreshQr() {
  const button = $('#btn-qr-refresh');
  setBusy(button, true, '刷新中…');
  try {
    const data = await api('login/refresh', { method: 'POST' });
    showQr(data.image);
    startLoginPolling();
  } catch (error) {
    toast(error.message, 'bad');
  } finally {
    setBusy(button, false);
  }
}

async function attachLogin() {
  const button = $('#btn-attach');
  setBusy(button, true);
  try {
    const port = Number($('#attach-port').value);
    const data = await api('chrome/attach', { method: 'POST', body: JSON.stringify({ port }) });
    updateLoginCard(data.login ?? {});
    toast(data.login?.loggedIn ? '检测到登录态' : '已连接，但这个 Chrome 还没登录', data.login?.loggedIn ? 'ok' : '');
    await loadStatus();
  } catch (error) {
    toast(error.message, 'bad');
  } finally {
    setBusy(button, false);
  }
}

async function logout() {
  if (!window.confirm('确定清除 B 站登录 Cookie 吗？下次需要重新扫码。')) return;
  const button = $('#btn-logout');
  setBusy(button, true);
  try {
    await api('login/logout', { method: 'POST' });
    toast('已退出登录', 'ok');
    updateLoginCard({ loggedIn: false });
    await loadStatus();
  } catch (error) {
    toast(error.message, 'bad');
  } finally {
    setBusy(button, false);
  }
}

function renderAllowlist(data) {
  const tbody = $('#allow-table tbody');
  if (!data.allow.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">白名单是空的。私信会保持关闭。</td></tr>';
  } else {
    tbody.innerHTML = data.allow
      .map((row) => {
        const isPlaceholder = Number(row.uid) === 0;
        const isOwner = row.owner === true;
        return `<tr>
          <td>${esc(row.uid)} ${isPlaceholder ? '<span class="tag bad">示例</span>' : ''}</td>
          <td>${isOwner ? '<span class="tag ok">主人</span> ' : ''}${esc(row.name || '—')}</td>
          <td class="muted">${esc(row.note || '')}</td>
          <td class="row-actions">
            ${isOwner
              ? '<span class="muted">评论只 @ 主人</span>'
              : `<button class="ghost" data-owner-uid="${esc(row.uid)}">设为主人</button>
                 <button class="ghost danger" data-delete-uid="${esc(row.uid)}">移除</button>`}
          </td>
        </tr>`;
      })
      .join('');
  }
  $('#allow-rules').innerHTML = data.rules.map((rule) => `<li>${esc(rule)}</li>`).join('');
}

async function loadAllowlist() {
  try {
    const data = await api('allowlist');
    state.allowlist = data;
    renderAllowlist(data);
  } catch (error) {
    toast(`读取白名单失败：${error.message}`, 'bad');
  }
}

async function submitAllowlist(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true);
  try {
    const data = await api('allowlist', { method: 'POST', body: JSON.stringify(payload) });
    state.allowlist = data;
    renderAllowlist(data);
    form.reset();
    toast('已加入白名单', 'ok');
    await loadStatus();
  } catch (error) {
    toast(error.message, 'bad');
  } finally {
    setBusy(button, false);
  }
}

async function deleteAllow(uid) {
  if (!window.confirm(`把 UID ${uid} 从白名单移除？移除后立即生效。`)) return;
  try {
    const data = await api(`allowlist/${encodeURIComponent(uid)}`, { method: 'DELETE' });
    state.allowlist = data;
    renderAllowlist(data);
    toast('已移除', 'ok');
    await loadStatus();
  } catch (error) {
    toast(error.message, 'bad');
  }
}

async function setOwner(uid) {
  if (!window.confirm(`把 UID ${uid} 设为主人？评论只会 @ 主人，私信也只会发给主人。`)) return;
  try {
    const data = await api(`allowlist/${encodeURIComponent(uid)}/owner`, { method: 'POST' });
    state.allowlist = data;
    renderAllowlist(data);
    toast('已设为主人', 'ok');
    await loadStatus();
  } catch (error) {
    toast(error.message, 'bad');
  }
}

function fieldControl(field, value) {
  const path = esc(field.path);
  if (field.kind === 'bool') {
    const locked = field.locked !== undefined;
    return `<label class="switch">
      <input type="checkbox" data-path="${path}" data-kind="bool" ${value ? 'checked' : ''} ${locked ? 'disabled' : ''} />
      <span>${value ? '已开启' : '已关闭'}${locked ? ' · 锁定' : ''}</span>
    </label>`;
  }
  if (field.kind === 'int' || field.kind === 'float') {
    const step = field.kind === 'int' ? 1 : field.step ?? 0.01;
    return `<input type="number" data-path="${path}" data-kind="${field.kind}" value="${esc(value)}"
      min="${field.min ?? ''}" max="${field.max ?? ''}" step="${step}" ${field.locked ? 'disabled' : ''} />`;
  }
  if (field.kind === 'string') {
    return `<input type="text" data-path="${path}" data-kind="string" value="${esc(value)}" maxlength="${field.maxLength ?? 120}" />`;
  }
  if (field.kind === 'timeRange' || field.kind === 'numberRange') {
    const type = field.kind === 'timeRange' ? 'time' : 'number';
    const [first, second] = Array.isArray(value) ? value : ['', ''];
    const attrs = field.kind === 'numberRange' ? `min="${field.min ?? ''}" max="${field.max ?? ''}" step="1"` : '';
    return `<div class="range">
      <input type="${type}" data-path="${path}" data-kind="${field.kind}" data-index="0" value="${esc(first)}" ${attrs} />
      <span>→</span>
      <input type="${type}" data-path="${path}" data-kind="${field.kind}" data-index="1" value="${esc(second)}" ${attrs} />
    </div>`;
  }
  if (field.kind === 'multienum') {
    const selected = new Set(Array.isArray(value) ? value : []);
    return `<div class="checks">${field.options
      .map(
        (option) => `<label><input type="checkbox" data-path="${path}" data-kind="multienum" value="${esc(option.value)}"
          ${selected.has(option.value) ? 'checked' : ''} />${esc(option.label)}</label>`,
      )
      .join('')}</div>`;
  }
  return `<span class="muted">不支持的字段类型：${esc(field.kind)}</span>`;
}

function renderConfig(config) {
  state.config = config;
  const container = $('#param-groups');
  const data = config.data ?? {};
  container.innerHTML = config.groups
    .map((group) => {
      const fields = group.fields
        .map((field) => {
          const value = field.path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), data);
          return `<div class="field">
            <span class="field-label">${esc(field.label)}${field.unit ? `<span class="muted">（${esc(field.unit)}）</span>` : ''}</span>
            ${fieldControl(field, value)}
            ${field.help ? `<span class="field-help">${esc(field.help)}</span>` : ''}
          </div>`;
        })
        .join('');
      return `<section class="fieldset">
        <h2>${esc(group.title)}</h2>
        <p>${esc(group.note ?? '')}</p>
        <div class="fields">${fields}</div>
      </section>`;
    })
    .join('');

  const banners = [];
  for (const error of config.errors) banners.push(`<div class="banner">${esc(error)}</div>`);
  for (const warning of config.warnings) banners.push(`<div class="banner warn">${esc(warning)}</div>`);
  $('#config-errors').innerHTML = banners.join('');

  $$('#param-groups input[data-kind="bool"]').forEach((input) => {
    input.addEventListener('change', () => {
      const label = input.closest('.switch')?.querySelector('span');
      if (label) label.textContent = `${input.checked ? '已开启' : '已关闭'}${input.disabled ? ' · 锁定' : ''}`;
    });
  });
}

async function loadConfig() {
  try {
    const config = await api('config');
    renderConfig(config);
  } catch (error) {
    toast(`读取参数失败：${error.message}`, 'bad');
  }
}

function collectPatch() {
  const patch = {};
  const ranges = new Map();
  const multi = new Map();

  $$('#param-groups [data-path]').forEach((input) => {
    const path = input.dataset.path;
    const kind = input.dataset.kind;

    if (kind === 'multienum') {
      if (!multi.has(path)) multi.set(path, []);
      if (input.checked) multi.get(path).push(input.value);
      return;
    }
    if (kind === 'timeRange' || kind === 'numberRange') {
      if (!ranges.has(path)) ranges.set(path, ['', '']);
      ranges.get(path)[Number(input.dataset.index)] = input.value;
      return;
    }
    if (kind === 'bool') {
      patch[path] = input.checked;
      return;
    }
    if (kind === 'int' || kind === 'float') {
      patch[path] = input.value === '' ? null : Number(input.value);
      return;
    }
    patch[path] = input.value;
  });

  for (const [path, value] of ranges.entries()) patch[path] = value;
  for (const [path, value] of multi.entries()) patch[path] = value;
  return patch;
}

async function saveParams() {
  const button = $('#btn-save-params');
  setBusy(button, true, '保存中…');
  try {
    const patch = collectPatch();
    const result = await api('config', { method: 'PUT', body: JSON.stringify({ patch }) });
    renderConfig({ ...state.config, data: result.data, errors: [], warnings: result.warnings ?? [] });
    $('#params-note').textContent = `已保存 ${result.changed?.length ?? 0} 项 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    toast('参数已保存', 'ok');
    await loadStatus();
  } catch (error) {
    toast(error.message, 'bad');
    $('#params-note').textContent = error.message;
  } finally {
    setBusy(button, false);
  }
}

async function loadAudit() {
  try {
    const data = await api('audit?limit=100');
    state.audit = data;
    $('#audit-meta').textContent = data.missing
      ? `还没有 ${data.file}，写操作审批通过后才会产生记录。`
      : `${data.file} · 共 ${data.total} 条${data.invalid ? ` · ${data.invalid} 行无法解析` : ''}`;
    renderAuditTable($('#audit-table'), data.entries, false);
  } catch (error) {
    toast(`读取审计失败：${error.message}`, 'bad');
  }
}

async function loadStatus() {
  try {
    const status = await api('status');
    state.status = status;
    $('#app-version').textContent = `v${status.app.version}`;
    renderOverview(status);
    if ($('#attach-port').value === '' || $('#attach-port').value === '9222') {
      $('#attach-port').value = String(status.chrome.port ?? 9222);
    }
  } catch (error) {
    toast(`读取状态失败：${error.message}`, 'bad');
  }
}

function bindEvents() {
  $('#nav').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-view]');
    if (button) go(button.dataset.view);
  });

  document.addEventListener('click', (event) => {
    const goto = event.target.closest('[data-goto]');
    if (goto) go(goto.dataset.goto);
    const del = event.target.closest('[data-delete-uid]');
    if (del) deleteAllow(del.dataset.deleteUid);
    const owner = event.target.closest('[data-owner-uid]');
    if (owner) setOwner(owner.dataset.ownerUid);
  });

  $('#btn-qr').addEventListener('click', startQr);
  $('#btn-qr-refresh').addEventListener('click', refreshQr);
  $('#btn-attach').addEventListener('click', attachLogin);
  $('#btn-logout').addEventListener('click', logout);
  $('#allow-form').addEventListener('submit', submitAllowlist);
  $('#btn-save-params').addEventListener('click', saveParams);
  $('#btn-audit-refresh').addEventListener('click', loadAudit);
}

async function boot() {
  bindEvents();
  await Promise.all([loadStatus(), loadAllowlist()]);
  state.statusTimer = setInterval(() => {
    if (document.visibilityState === 'visible') loadStatus();
  }, 15000);
}

boot();
