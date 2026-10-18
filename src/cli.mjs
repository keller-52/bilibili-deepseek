#!/usr/bin/env node
import { buildStatus } from './server.mjs';
import { getOwner, loadAllowlist } from './allowlist.mjs';
import { ensureOwnerMention } from './policy.mjs';
import { sendOwnerDm } from './dm.mjs';

const args = process.argv.slice(2);
const command = args[0] ?? 'status';

async function printStatus(asJson) {
  const status = await buildStatus();
  if (asJson) {
    console.log(JSON.stringify(status, null, 2));
    process.exitCode = status.config.errors.length ? 1 : 0;
    return;
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
  console.log(`白名单      ${status.allowlist.count} 人${status.allowlist.owner ? `，主人 ${status.allowlist.owner.name}` : '，未标主人'}${status.allowlist.placeholder ? '（仍是示例 UID 0）' : ''}`);
  console.log(`审计        ${status.audit.total} 条${status.audit.missing ? '（还没有文件）' : ''}`);
  console.log(`控制台      http://127.0.0.1:${process.env.BILI_DUTY_PORT || 7801} （npm start）`);

  for (const error of status.config.errors) console.error(`! ${error}`);
  for (const warning of status.config.warnings) console.error(`· ${warning}`);
  process.exitCode = status.config.errors.length ? 1 : 0;
}

if (command === 'dm') {
  const rest = args.slice(1);
  const portIndex = rest.indexOf('--port');
  const port = portIndex === -1 ? 9222 : Number(rest.splice(portIndex, 2)[1]);
  const dryRun = rest.includes('--dry-run');
  if (dryRun) rest.splice(rest.indexOf('--dry-run'), 1);
  const text = rest.join(' ').trim();
  if (!text) {
    console.error('用法：node src/cli.mjs dm [--dry-run] [--port 9222] "私信内容"');
    process.exitCode = 1;
  } else {
    const result = await sendOwnerDm(text, { port, dryRun });
    if (result.ok) {
      const head = dryRun ? '预览通过（未发送）' : result.verified ? '已发送并确认' : '已点击发送，但无法确认';
      console.log(`${head} → ${result.owner.name} (UID ${result.owner.uid})`);
      if (result.screenshot) console.log(`截图：${result.screenshot}`);
      if (result.errors?.length) console.error(`提示：${result.errors.join('；')}`);
    } else {
      console.error(`发送失败：${(result.errors ?? []).join('；')}`);
      process.exitCode = 1;
    }
  }
} else if (command === 'comment-check') {
  const text = args.slice(1).join(' ').trim();
  if (!text) {
    console.error('用法：node src/cli.mjs comment-check "评论草稿"');
    process.exitCode = 1;
  } else {
    const allowlist = await loadAllowlist();
    const owner = getOwner(allowlist);
    const result = ensureOwnerMention(text, owner);
    if (result.ok) {
      console.log(result.added ? `已补上 @${owner.name}：` : '通过：');
      console.log(result.text);
    } else {
      console.error(result.errors.join('；'));
      process.exitCode = 1;
    }
  }
} else {
  await printStatus(args.includes('--json'));
}
