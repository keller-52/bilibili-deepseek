#!/usr/bin/env node
import { buildStatus } from './server.mjs';
import { getOwner, loadAllowlist } from './allowlist.mjs';
import { ensureOwnerMention } from './policy.mjs';
import { sendOwnerDm } from './dm.mjs';
import { readVideo, searchVideos } from './read.mjs';
import { readWatched } from './memory.mjs';
import { runtimePaths } from './paths.mjs';
import { loadConfig } from './config.mjs';

const args = process.argv.slice(2);
const command = args[0] ?? 'status';

function takeFlag(list, name) {
  const index = list.indexOf(name);
  if (index === -1) return null;
  return list.splice(index, 2)[1] ?? null;
}

function hasFlag(list, name) {
  const index = list.indexOf(name);
  if (index === -1) return false;
  list.splice(index, 1);
  return true;
}

function printUsage() {
  console.log(`bili-duty CLI

  node src/cli.mjs status [--json]
  node src/cli.mjs search "关键词" [--limit 5] [--json]
  node src/cli.mjs video BV1xx... [--comments 20] [--order hot|new] [--note "笔记"] [--json]
  node src/cli.mjs watched [--limit 20] [--json]
  node src/cli.mjs comment-check "评论草稿"
  node src/cli.mjs dm [--dry-run] [--port 9222] "私信内容"
`);
}

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
} else if (command === 'search') {
  const rest = args.slice(1);
  const asJson = hasFlag(rest, '--json');
  const limit = takeFlag(rest, '--limit') ?? 5;
  const query = rest.join(' ').trim();
  if (!query) {
    console.error('用法：node src/cli.mjs search "关键词" [--limit 5] [--json]');
    process.exitCode = 1;
  } else {
    const result = await searchVideos(query, { limit: Number(limit) });
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
    } else if (!result.ok) {
      console.error(`搜索失败：${(result.errors ?? []).join('；')}`);
      process.exitCode = 1;
    } else {
      console.log(`「${result.query}」· ${result.items.length} 个视频 · ${Math.round(result.tookMs / 1000)}s`);
      result.items.forEach((item, index) => {
        const facts = [item.author, item.duration, `${item.play || '—'} 播放`].filter(Boolean).join(' · ');
        console.log(`${index + 1}. ${item.title}`);
        console.log(`   ${item.bvid} · ${facts}`);
      });
    }
  }
} else if (command === 'video') {
  const rest = args.slice(1);
  const asJson = hasFlag(rest, '--json');
  const comments = takeFlag(rest, '--comments') ?? 20;
  const order = takeFlag(rest, '--order') ?? 'hot';
  const note = takeFlag(rest, '--note') ?? '';
  const target = rest.join(' ').trim();
  if (!target) {
    console.error('用法：node src/cli.mjs video BV1xx... [--comments 20] [--order hot|new] [--note "笔记"] [--json]');
    process.exitCode = 1;
  } else {
    const result = await readVideo(target, { comments: Number(comments), order, note });
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
    } else if (!result.ok) {
      console.error(`读取失败：${(result.errors ?? []).join('；')}`);
      if (result.screenshot) console.error(`截图：${result.screenshot}`);
      process.exitCode = 1;
    } else {
      const video = result.video;
      console.log(`${video.title}`);
      console.log(`UP：${video.author || '—'}${video.authorUid ? `（UID ${video.authorUid}）` : ''}`);
      console.log(`BV：${result.bvid} · 播放 ${video.view || '—'} · 点赞 ${video.like || '—'} · 评论 ${result.commentsTotal || '—'}`);
      console.log(`评论区：已读 ${result.comments.length} 条（${result.sort === 'time' ? '最新' : '最热'}）`);
      result.comments.forEach((comment, index) => {
        const meta = [comment.author || '匿名', comment.pubdate, comment.likes ? `${comment.likes} 赞` : ''].filter(Boolean).join(' · ');
        console.log(`\n${index + 1}. ${meta}`);
        console.log(comment.text);
      });
      if (result.memory) {
        console.log(`\n记忆：${result.memory.watched}`);
        console.log(`日记：${result.memory.note}`);
      }
    }
  }
} else if (command === 'watched') {
  const rest = args.slice(1);
  const asJson = hasFlag(rest, '--json');
  const limit = takeFlag(rest, '--limit') ?? 20;
  const config = await loadConfig();
  const paths = runtimePaths(config.data);
  const data = await readWatched(paths.memory, Number(limit));
  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`看过 ${data.total} 个视频 · ${data.file}`);
    if (data.missing) console.log('（还没有记录）');
    for (const entry of data.entries) {
      console.log(`- ${entry.ts}  ${entry.title}  ${entry.bvid}`);
      if (entry.commentsRead) console.log(`  ${entry.commentsRead} 条评论${entry.note ? ` · ${entry.note}` : ''}`);
    }
  }
} else if (command === 'help' || command === '--help' || command === '-h') {
  printUsage();
} else {
  await printStatus(args.includes('--json'));
}
