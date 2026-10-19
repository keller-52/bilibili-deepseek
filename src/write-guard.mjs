// Deterministic write gate for bili-duty.
//
// The rule engine is intentionally conservative: obvious violations are
// rejected here, ambiguous content is sent to human review, and the AI
// reviewer / human approval layers run afterwards. This module never touches
// the browser and never sends anything.

import { loadConfig } from './config.mjs';
import { loadAllowlist, getOwner } from './allowlist.mjs';
import { runtimePaths } from './paths.mjs';
import { tailAudit } from './audit.mjs';
import { findStopFile } from './guard.mjs';
import { ensureOwnerMention } from './policy.mjs';

const BVID_RE = /BV[0-9A-Za-z]{10}/;
const BILIBILI_DOMAIN_RE = /(^|\.)bilibili\.com$/i;
const LINK_RE = /(https?:\/\/|www\.|b23\.tv|bili2233\.cn|\b[a-z0-9-]+\.(?:com|cn|net|org|io|tv|cc|me|top|xyz|shop)\b)/i;
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const REPEAT_RE = /(.)\1{7,}/u;
const ONLY_SYMBOL_RE = /^[\s\p{P}\p{S}\p{Emoji_Presentation}]+$/u;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const ACTIONS = {
  comment: { label: '评论', maxLength: 300, humanLength: 100, target: 'video', mention: true, public: true },
  reply: { label: '回复', maxLength: 300, humanLength: 100, target: 'video', mention: true, public: true },
  danmaku: { label: '弹幕', maxLength: 100, humanLength: 60, target: 'video', mention: false, public: true },
  dm: { label: '私信', maxLength: 300, humanLength: 300, target: 'person', mention: false, public: false },
  dynamic: { label: '动态', maxLength: 2000, humanLength: 2000, target: 'none', mention: false, public: true },
  like: { label: '点赞', maxLength: 0, humanLength: 0, target: 'video', mention: false, public: false },
  coin: { label: '投币', maxLength: 0, humanLength: 0, target: 'video', mention: false, public: false },
  favorite: { label: '收藏', maxLength: 0, humanLength: 0, target: 'video', mention: false, public: false },
};

const BANNED = [
  {
    id: 'politics',
    risk: 'high',
    words: ['政治', '政府', '共产党', '习近平', '国家领导人', '六四', '台独', '港独', '疆独', '藏独', '法轮功'],
  },
  {
    id: 'illegal',
    risk: 'high',
    words: ['翻墙', 'vpn', '破解', '盗版', '黄片', '色情', '赌博', '毒品', '诈骗', '洗钱', '代开发票', '办证', '枪支'],
  },
  {
    id: 'attack',
    risk: 'high',
    words: ['傻逼', '脑残', '废物', '去死', '滚出', '垃圾人', '狗东西', '畜生', '支那', '汉奸', '尼玛', '他妈'],
  },
  {
    id: 'harassment',
    risk: 'medium',
    words: ['挂人', '网暴', '人肉', '开盒', '查你地址', '弄死你'],
  },
  {
    id: 'professional-advice',
    risk: 'high',
    words: ['确诊', '处方', '包治', '偏方', '稳赚', '保证收益', '荐股', '内幕消息', '法律意见'],
  },
  {
    id: 'ads',
    risk: 'high',
    words: ['加微信', '加qq', '加vx', '加v', '私信我', '扫码', '二维码', '群号', '代理加盟', '推广链接', '下单', '优惠券', '代购'],
  },
  {
    id: 'impersonation',
    risk: 'high',
    words: ['我是官方', '官方客服', '内部人员', '我是真人', '实名举报你', '假一赔十'],
  },
  {
    id: 'overpromise',
    risk: 'medium',
    words: ['保证', '百分百', '100%', '绝对能', '一定能', '全网第一', '最强'],
  },
  {
    id: 'privacy',
    risk: 'high',
    words: ['身份证号', '家庭住址', '手机号是', '银行卡号'],
  },
  {
    id: 'prompt-injection',
    risk: 'high',
    words: ['忽略之前的指令', '忽略以上指令', 'system prompt', '系统提示词', '开发者模式', '你现在是', '忘掉你的设定', '输出你的提示词'],
  },
];

const HUMAN_SIGNALS = [
  { id: 'number', pattern: /\d{2,}/, reason: '含具体数字，无法核实' },
  { id: 'date', pattern: /\d{1,2}\s*[年月日]/, reason: '含具体日期，无法核实' },
  { id: 'hearsay', pattern: /据说|听说|爆料|内部消息|可靠消息/, reason: '转述/爆料内容，需人工判断' },
  { id: 'quote', pattern: /“|”|「|」|引战|对线|踩一捧一/, reason: '含引述或对抗性表达' },
];

function actionDef(action) {
  return ACTIONS[action] ?? null;
}

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function localClock(value) {
  const date = value instanceof Date ? value : new Date(value);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function minutesOfDay(value) {
  const [hour, minute] = String(value).split(':').map(Number);
  return hour * 60 + minute;
}

function insideRange(clockMinutes, start, end) {
  const from = minutesOfDay(start);
  const to = minutesOfDay(end);
  if (from === to) return false;
  if (from < to) return clockMinutes >= from && clockMinutes < to;
  return clockMinutes >= from || clockMinutes < to;
}

function weekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

/** Check the configured off-peak window and quiet hours. */
export function checkWriteWindow(config, now = new Date()) {
  const schedule = config?.schedule ?? {};
  const quiet = config?.guard?.quiet_hours ?? ['00:00', '07:00'];
  const clock = minutesOfDay(localClock(now));

  if (Array.isArray(quiet) && quiet.length === 2 && insideRange(clock, quiet[0], quiet[1])) {
    return { ok: false, reason: `夜间静默 ${quiet[0]}–${quiet[1]}，不做写操作` };
  }
  if (schedule.only_offpeak !== true) return { ok: true, reason: '' };
  if (schedule.weekend_all_day === true && weekend(now)) return { ok: true, reason: '周末全天谷时' };

  const windows = schedule.windows ?? {};
  const ranges = [windows.noon, windows.night].filter((item) => Array.isArray(item) && item.length === 2);
  const matched = ranges.find(([start, end]) => insideRange(clock, start, end));
  if (!matched) {
    return { ok: false, reason: `当前 ${localClock(now)} 不在谷时窗口（只允许 12:00–14:00、18:00–次日 09:00 或周末）` };
  }

  const stopBefore = Math.max(0, Number(schedule.stop_write_before_end_min ?? 0));
  if (stopBefore > 0) {
    const end = minutesOfDay(matched[1]);
    let minutesToEnd = end - clock;
    if (minutesToEnd <= 0) minutesToEnd += 24 * 60;
    if (minutesToEnd <= stopBefore) {
      return { ok: false, reason: `窗口结束前 ${stopBefore} 分钟停止写操作` };
    }
  }
  return { ok: true, reason: '谷时窗口内' };
}

export function normalizeWriteText(action, content) {
  const def = actionDef(action);
  if (!def) return { ok: false, errors: [`未知动作：${action}`] };
  if (def.maxLength === 0) return { ok: true, text: '' };
  const text = String(content ?? '')
    .replace(CONTROL_RE, '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!text) return { ok: false, errors: [`${def.label}内容不能为空`] };
  const length = Array.from(text).length;
  if (length > def.maxLength) {
    return { ok: false, errors: [`${def.label}不能超过 ${def.maxLength} 字（当前 ${length}）`] };
  }
  return { ok: true, text, length };
}

function normalizeTarget(action, target) {
  const def = actionDef(action);
  if (!def) return { ok: false, errors: [`未知动作：${action}`] };
  const raw = target ?? {};
  if (def.target === 'video') {
    const match = BVID_RE.exec(String(raw.bvid ?? raw.url ?? ''));
    if (!match) return { ok: false, errors: ['目标需要一个 BV 号或视频链接'] };
    const normalized = { bvid: match[0] };
    if (action === 'reply') {
      const rootId = String(raw.rootId ?? raw.root ?? '').trim();
      if (!rootId) return { ok: false, errors: ['回复需要指定根评论（rootId）'] };
      normalized.rootId = rootId;
      if (raw.authorUid != null) {
        const uid = Number(raw.authorUid);
        if (Number.isInteger(uid) && uid > 0) normalized.authorUid = uid;
      }
    }
    return { ok: true, target: normalized };
  }
  if (def.target === 'person') {
    const uid = Number(raw.uid ?? raw.targetUid);
    if (!Number.isInteger(uid) || uid <= 0) return { ok: false, errors: ['私信目标需要一个正整数 UID'] };
    return { ok: true, target: { uid } };
  }
  return { ok: true, target: {} };
}

function scanContent(text) {
  const reasons = [];
  let risk = 'low';

  if (LINK_RE.test(text) || BILIBILI_DOMAIN_RE.test(text)) {
    reasons.push('包含链接或站外域名');
    risk = 'high';
  }
  if (PHONE_RE.test(text) || EMAIL_RE.test(text)) {
    reasons.push('包含手机号或邮箱');
    risk = 'high';
  }
  if (REPEAT_RE.test(text) || ONLY_SYMBOL_RE.test(text)) {
    reasons.push('疑似低质刷屏（重复字符 / 纯符号）');
    risk = 'medium';
  }

  for (const group of BANNED) {
    const hit = group.words.find((word) => text.toLowerCase().includes(word.toLowerCase()));
    if (hit) {
      reasons.push(`命中禁止项（${group.id}）：${hit}`);
      risk = group.risk === 'high' ? 'high' : risk === 'high' ? 'high' : 'medium';
    }
  }

  return {
    reasons,
    risk,
    banned: reasons.length > 0,
  };
}

function countToday(entries, action, now, extra = () => true) {
  const today = localDateKey(now);
  return (entries ?? []).filter(
    (entry) =>
      entry?.action === action &&
      entry?.exec === 'ok' &&
      entry?.ts &&
      localDateKey(entry.ts) === today &&
      extra(entry),
  ).length;
}

function lastEntry(entries, action) {
  return (entries ?? [])
    .filter((entry) => entry?.action === action && entry?.exec === 'ok' && entry?.ts)
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())[0];
}

function targetMatches(entry, target) {
  if (target.bvid && entry?.target && String(entry.target) !== target.bvid) return false;
  if (target.rootId && entry?.root !== target.rootId && entry?.root_id !== target.rootId) return false;
  if (target.uid != null && Number(entry?.target) !== Number(target.uid)) return false;
  return true;
}

/** Quota checks based on successful audit entries. */
export function checkWriteQuota(action, target, entries, config, now = new Date()) {
  const l1 = config?.l1 ?? {};
  const l2 = config?.l2 ?? {};
  const l3 = config?.l3 ?? {};
  const checks = [];

  const at = (name, limit) => {
    if (!Number.isFinite(Number(limit)) || Number(limit) <= 0) checks.push({ name, limit: Number(limit), reason: '' });
    return Number(limit);
  };

  if (action === 'comment') {
    const perDay = countToday(entries, 'comment', now);
    const perVideo = countToday(entries, 'comment', now, (entry) => targetMatches(entry, target));
    const total = countToday(entries, 'comment', now) + countToday(entries, 'reply', now);
    const last = lastEntry(entries, 'comment');
    const minInterval = Number(l2.comment_min_interval_sec ?? 600);
    if (perDay >= at('comment_per_day', l2.comment_per_day ?? 3)) return { ok: false, reason: `今天主评论已达上限（${l2.comment_per_day ?? 3} 条）` };
    if (perVideo >= at('comment_per_video', l2.comment_per_video ?? 1)) return { ok: false, reason: '同一个视频今天已经评论过' };
    if (total >= at('total_per_day', l2.total_per_day ?? 10)) return { ok: false, reason: `今天评论 + 回复已达上限（${l2.total_per_day ?? 10} 条）` };
    if (last?.ts && minInterval > 0) {
      const elapsed = (now.getTime() - new Date(last.ts).getTime()) / 1000;
      if (elapsed < minInterval) return { ok: false, reason: `距离上一条评论只有 ${Math.round(elapsed)} 秒，最小间隔 ${minInterval} 秒` };
    }
  } else if (action === 'reply') {
    const perDay = countToday(entries, 'reply', now);
    const perRoot = countToday(entries, 'reply', now, (entry) => targetMatches(entry, target));
    const total = countToday(entries, 'comment', now) + countToday(entries, 'reply', now);
    const person = target.authorUid ? countToday(entries, 'reply', now, (entry) => Number(entry.target_uid) === Number(target.authorUid)) : 0;
    const last = lastEntry(entries, 'reply');
    const minInterval = Number(l2.comment_min_interval_sec ?? 600);
    if (perDay >= at('reply_per_day', l2.reply_per_day ?? 10)) return { ok: false, reason: `今天回复已达上限（${l2.reply_per_day ?? 10} 条）` };
    if (perRoot >= at('reply_per_root', l2.reply_per_root ?? 2)) return { ok: false, reason: '同一条根评论下回复已达上限' };
    if (total >= at('total_per_day', l2.total_per_day ?? 10)) return { ok: false, reason: `今天评论 + 回复已达上限（${l2.total_per_day ?? 10} 条）` };
    if (target.authorUid && person >= at('per_person_per_day', l2.per_person_per_day ?? 1)) {
      return { ok: false, reason: '今天对同一个人回复已达上限' };
    }
    if (last?.ts && minInterval > 0) {
      const elapsed = (now.getTime() - new Date(last.ts).getTime()) / 1000;
      if (elapsed < minInterval) return { ok: false, reason: `距离上一条回复只有 ${Math.round(elapsed)} 秒，最小间隔 ${minInterval} 秒` };
    }
  } else if (action === 'danmaku') {
    const perDay = countToday(entries, 'danmaku', now);
    if (perDay >= (l2.danmaku_per_day ?? 5)) return { ok: false, reason: `今天弹幕已达上限（${l2.danmaku_per_day ?? 5} 条）` };
  } else if (action === 'dm') {
    const perDay = countToday(entries, 'dm', now);
    const perPerson = countToday(entries, 'dm', now, (entry) => Number(entry.target) === Number(target.uid));
    const last = lastEntry(entries, 'dm');
    if (perDay >= (l2.dm_per_day ?? 10)) return { ok: false, reason: `今天私信已达上限（${l2.dm_per_day ?? 10} 条）` };
    if (perPerson >= (l2.dm_per_person_per_day ?? 3)) return { ok: false, reason: '今天给这个人的私信已达上限' };
    if (last?.ts) {
      const elapsed = (now.getTime() - new Date(last.ts).getTime()) / 1000;
      const interval = Number(l2.dm_min_interval_sec ?? 300);
      if (elapsed < interval) return { ok: false, reason: `距离上一条私信只有 ${Math.round(elapsed)} 秒，最小间隔 ${interval} 秒` };
    }
  } else if (action === 'dynamic') {
    if (l3.enabled !== true) return { ok: false, reason: 'L3 未启用（l3.enabled=false）' };
    const perDay = countToday(entries, 'dynamic', now);
    if (perDay >= (l3.dynamic_per_day ?? 1)) return { ok: false, reason: `今天动态已达上限（${l3.dynamic_per_day ?? 1} 篇）` };
  } else if (action === 'like') {
    if (countToday(entries, 'like', now) >= (l1.like_per_day ?? 20)) return { ok: false, reason: '今天点赞已达上限' };
  } else if (action === 'coin') {
    if (countToday(entries, 'coin', now) >= (l1.coin_per_day ?? 1)) return { ok: false, reason: '今天投币已达上限' };
  } else if (action === 'favorite') {
    if (countToday(entries, 'favorite', now) >= (l1.favorite_per_day ?? 10)) return { ok: false, reason: '今天收藏已达上限' };
  } else {
    return { ok: false, reason: `未知动作：${action}` };
  }

  return { ok: true, reason: '' };
}

function duplicate(text, action, entries, now) {
  const since = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const normalized = text.replace(/\s+/g, ' ').trim();
  return (entries ?? []).some(
    (entry) =>
      entry?.action === action &&
      entry?.exec === 'ok' &&
      entry?.ts &&
      new Date(entry.ts).getTime() >= since &&
      String(entry.content ?? '').replace(/\s+/g, ' ').trim() === normalized,
  );
}

/**
 * Run the deterministic rule layer. Returns `pass`, `human`, or `reject`.
 * Never sends anything; `config`, `allowlist`, `entries`, and `home` are
 * injectable for offline tests.
 */
export async function guardWrite({
  action,
  content,
  target,
  config,
  allowlist,
  entries,
  now = new Date(),
  home,
  skipWindow = false,
} = {}) {
  const def = actionDef(action);
  if (!def) return { ok: false, action, verdict: 'reject', risk: 'high', reasons: [`未知动作：${action}`], checks: {} };

  let effectiveConfig = config;
  let effectiveAllowlist = allowlist;
  let effectiveEntries = entries;
  let effectiveHome = home;
  try {
    if (!effectiveConfig || !effectiveAllowlist) {
      effectiveConfig = effectiveConfig ?? (await loadConfig());
      effectiveAllowlist = effectiveAllowlist ?? (await loadAllowlist());
    }
    const resolvedConfig = effectiveConfig.data ? effectiveConfig : { data: effectiveConfig };
    const paths = runtimePaths(resolvedConfig.data);
    effectiveHome = effectiveHome ?? paths.home;
    if (!effectiveEntries) {
      effectiveEntries = (await tailAudit(paths.audit, 200)).entries;
    }
    const cfg = resolvedConfig.data ?? {};
    const allow = effectiveAllowlist;
    const owner = getOwner(allow);

    const stop = await findStopFile(cfg, { home: effectiveHome });
    if (stop) {
      return {
        ok: false,
        action,
        verdict: 'reject',
        risk: 'high',
        reasons: [`急停：检测到 ${stop}`],
        checks: { stop: true },
      };
    }

    const textResult = normalizeWriteText(action, content);
    if (!textResult.ok) {
      return { ok: false, action, verdict: 'reject', risk: 'medium', reasons: textResult.errors, checks: { length: false } };
    }
    const targetResult = normalizeTarget(action, target);
    if (!targetResult.ok) {
      return { ok: false, action, verdict: 'reject', risk: 'medium', reasons: targetResult.errors, checks: { target: false } };
    }

    const reasons = [];
    let verdict = 'pass';
    let risk = 'low';
    let text = textResult.text;
    const checks = {};

    if (def.mention) {
      if (!owner) {
        return { ok: false, action, verdict: 'reject', risk: 'high', reasons: ['白名单里还没有标记主人（owner）'], checks: { owner: false } };
      }
      const mention = ensureOwnerMention(text, owner);
      if (!mention.ok) {
        return { ok: false, action, verdict: 'reject', risk: 'high', reasons: mention.errors, checks: { mention: false } };
      }
      text = mention.text;
      checks.mention = mention.added ? `补充 @${owner.name}` : `只 @${owner.name}`;
      if (mention.added) reasons.push(`已补充 @${owner.name}`);
    }

    if (def.maxLength > 0 && Array.from(text).length > def.maxLength) {
      return {
        ok: false,
        action,
        verdict: 'reject',
        risk: 'medium',
        reasons: [`补上 @主人 后超过 ${def.maxLength} 字`],
        text,
        target: targetResult.target,
        checks: { ...checks, length: false },
      };
    }

    if (action === 'dm') {
      if (!owner || Number(targetResult.target.uid) !== Number(owner.uid)) {
        return { ok: false, action, verdict: 'reject', risk: 'high', reasons: ['私信只能发给白名单里标记的主人'], checks: { owner: false } };
      }
      if (cfg.l2?.dm_allow_links === true) {
        return { ok: false, action, verdict: 'reject', risk: 'high', reasons: ['私信禁止链接（dm_allow_links 必须为 false）'], checks: { links: false } };
      }
    }

    if (def.public && (action === 'comment' || action === 'reply' || action === 'danmaku' || action === 'dynamic')) {
      const scan = scanContent(text);
      if (scan.banned) {
        return { ok: false, action, verdict: 'reject', risk: scan.risk, reasons: scan.reasons, text, target: targetResult.target, checks: { ...checks, content: false } };
      }
      if (scan.reasons.length) {
        reasons.push(...scan.reasons);
        verdict = 'human';
        risk = scan.risk;
      }
      checks.content = 'clean';
    } else if (action === 'dm') {
      const scan = scanContent(text);
      if (scan.banned) {
        return { ok: false, action, verdict: 'reject', risk: scan.risk, reasons: scan.reasons, text, target: targetResult.target, checks: { ...checks, content: false } };
      }
      if (scan.reasons.length) {
        reasons.push(...scan.reasons);
        verdict = 'human';
        risk = scan.risk;
      }
    }

    const length = Array.from(text).length;
    if (def.humanLength > 0 && length > def.humanLength) {
      reasons.push(`${def.label}超过 ${def.humanLength} 字，转人工`);
      verdict = 'human';
      risk = risk === 'high' ? 'high' : 'medium';
    }

    for (const signal of HUMAN_SIGNALS) {
      if (signal.pattern.test(text)) {
        reasons.push(signal.reason);
        verdict = verdict === 'reject' ? verdict : 'human';
        risk = risk === 'high' ? 'high' : 'medium';
      }
    }

    if (duplicate(text, action, effectiveEntries, now)) {
      return { ok: false, action, verdict: 'reject', risk: 'medium', reasons: ['7 天内已经发过相同内容'], text, target: targetResult.target, checks: { ...checks, duplicate: false } };
    }
    checks.duplicate = 'none';

    if (action === 'dynamic' && cfg.l3?.enabled !== true) {
      return { ok: false, action, verdict: 'reject', risk: 'high', reasons: ['L3 未启用（l3.enabled=false）'], text, target: targetResult.target, checks };
    }

    const quota = checkWriteQuota(action, targetResult.target, effectiveEntries, cfg, now);
    if (!quota.ok) {
      return { ok: false, action, verdict: 'reject', risk: 'medium', reasons: [quota.reason], text, target: targetResult.target, checks: { ...checks, quota: false } };
    }
    checks.quota = 'ok';

    const window = skipWindow ? { ok: true, reason: '草稿阶段跳过时间窗口（执行时再检查）' } : checkWriteWindow(cfg, now);
    if (!window.ok) {
      return { ok: false, action, verdict: 'reject', risk: 'medium', reasons: [window.reason], text, target: targetResult.target, checks: { ...checks, window: false } };
    }
    checks.window = window.reason;

    if (cfg.review?.rule_engine !== true) {
      return { ok: false, action, verdict: 'reject', risk: 'high', reasons: ['规则引擎未启用（review.rule_engine 必须为 true）'], text, target: targetResult.target, checks };
    }

    return {
      ok: verdict !== 'reject',
      action,
      verdict,
      risk: verdict === 'reject' ? 'high' : risk,
      reasons,
      text,
      target: targetResult.target,
      owner: owner ? { uid: Number(owner.uid), name: owner.name } : null,
      checks,
    };
  } catch (error) {
    return {
      ok: false,
      action,
      verdict: 'reject',
      risk: 'high',
      reasons: [`规则检查失败：${error.message}`],
      checks: { error: true },
    };
  }
}

export { ACTIONS, BANNED, LINK_RE };
