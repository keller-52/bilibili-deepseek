#!/usr/bin/env node
import { buildStatus } from './server.mjs';

const asJson = process.argv.includes('--json');
const status = await buildStatus();

if (asJson) {
  console.log(JSON.stringify(status, null, 2));
  process.exit(status.config.errors.length ? 1 : 0);
}

const chrome = status.chrome.cdp
  ? `已连接 (${status.chrome.browser ?? 'Chrome'}, 端口 ${status.chrome.port})`
  : status.chrome.found
    ? `未启动（找到 ${status.chrome.path}）`
    : '没找到 Chrome';
const login = status.login.loggedIn
  ? `已登录 UID ${status.login.uid}${status.login.nickname ? ` (${status.login.nickname})` : ''}`
  : '未登录';

console.log(`bili-duty v${status.app.version}  ${status.paths.root}`);
console.log(`Chrome      ${chrome}`);
console.log(`B 站登录    ${login}`);
console.log(`白名单      ${status.allowlist.count} 人${status.allowlist.placeholder ? '（仍是示例 UID 0）' : ''}`);
console.log(`审计        ${status.audit.total} 条${status.audit.missing ? '（还没有文件）' : ''}`);
console.log(`控制台      http://127.0.0.1:${process.env.BILI_DUTY_PORT || 7801} （npm start）`);

for (const error of status.config.errors) console.error(`! ${error}`);
for (const warning of status.config.warnings) console.error(`· ${warning}`);
process.exit(status.config.errors.length ? 1 : 0);
