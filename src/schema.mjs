// Editable parameter catalogue.
//
// This is the single place the control panel learns which keys exist, how to
// render them and how to validate them. It intentionally mirrors
// `config/config.yaml`; every field here must exist in that file.

export const PARAM_GROUPS = [
  {
    id: 'interaction',
    title: '互动配额（L1 / L2）',
    note: '数值越保守，账号越安全。调大之前先看审计里的实际用量。',
    fields: [
      { path: 'l1.like_per_day', label: '每天点赞上限', kind: 'int', min: 0, max: 100, unit: '次' },
      { path: 'l1.coin_per_day', label: '每天投币上限', kind: 'int', min: 0, max: 10, unit: '枚', help: '硬币稀缺，默认 1。' },
      { path: 'l1.favorite_per_day', label: '每天收藏上限', kind: 'int', min: 0, max: 100, unit: '次' },
      { path: 'l2.comment_per_video', label: '同一视频最多评论', kind: 'int', min: 0, max: 5, unit: '条' },
      { path: 'l2.reply_per_root', label: '同一条根评论下最多回复', kind: 'int', min: 0, max: 10, unit: '条' },
      { path: 'l2.comment_per_day', label: '每天主评论上限', kind: 'int', min: 0, max: 20, unit: '条' },
      { path: 'l2.reply_per_day', label: '每天回复上限', kind: 'int', min: 0, max: 50, unit: '条' },
      { path: 'l2.total_per_day', label: '每天评论 + 回复合计', kind: 'int', min: 0, max: 50, unit: '条' },
      { path: 'l2.per_person_per_day', label: '对同一个人每天最多', kind: 'int', min: 0, max: 10, unit: '条' },
      { path: 'l2.comment_min_interval_sec', label: '两条评论/回复最小间隔', kind: 'int', min: 60, max: 86400, unit: '秒' },
      { path: 'l2.danmaku_per_day', label: '每天弹幕上限', kind: 'int', min: 0, max: 20, unit: '条' },
    ],
  },
  {
    id: 'dm',
    title: '私信',
    note: '只允许发给白名单里、明确知道这是 AI 的人。链接与群发在代码层禁止。',
    fields: [
      { path: 'l2.dm_per_day', label: '每天私信上限', kind: 'int', min: 0, max: 50, unit: '条' },
      { path: 'l2.dm_per_person_per_day', label: '同一人每天最多', kind: 'int', min: 0, max: 10, unit: '条' },
      { path: 'l2.dm_min_interval_sec', label: '两条私信最小间隔', kind: 'int', min: 60, max: 86400, unit: '秒' },
      { path: 'l2.dm_require_human', label: '私信需要人工确认', kind: 'bool', help: '默认关闭（好友已知情）；重要消息可临时打开。' },
      { path: 'l2.dm_allow_links', label: '允许私信带链接', kind: 'bool', locked: false, help: '硬约束，保持关闭。' },
    ],
  },
  {
    id: 'publish',
    title: '发布（L3）',
    note: '动态默认关闭；即使打开，也必须人工点最后一下。投稿视频全人工。',
    fields: [
      { path: 'l3.enabled', label: '启用 L3 能力', kind: 'bool', help: '关闭时不会注册任何发布工具。' },
      { path: 'l3.dynamic_per_day', label: '每天动态上限', kind: 'int', min: 0, max: 3, unit: '篇' },
      { path: 'l3.dynamic_require_human', label: '动态必须人工审核', kind: 'bool', locked: true },
    ],
  },
  {
    id: 'review',
    title: '审核',
    note: '生成者不参与审核。规则引擎在代码里，改提示词无效。',
    fields: [
      { path: 'review.rule_engine', label: '启用规则引擎', kind: 'bool', locked: true },
      { path: 'review.human_required', label: '默认人工必经', kind: 'bool', help: 'AUTO 通道命中白名单动作时可豁免。' },
    ],
  },
  {
    id: 'auto',
    title: 'AUTO 通道',
    note: '默认关闭。开启前应满足：连续 14 天无风控、累计 20 条核验可见、抽检通过率 ≥95%。',
    fields: [
      { path: 'auto.enabled', label: '启用 AUTO', kind: 'bool' },
      {
        path: 'auto.allowed_actions',
        label: '允许自动的动作',
        kind: 'multienum',
        options: [
          { value: 'dm_owner', label: '私信账号本人' },
          { value: 'reply_owner', label: '回复账号本人' },
          { value: 'short_comment', label: '短评论（≤50 字）' },
        ],
      },
      { path: 'auto.min_clean_days', label: '连续无风控天数', kind: 'int', min: 0, max: 365, unit: '天' },
      { path: 'auto.min_verified_count', label: '累计核验可见条数', kind: 'int', min: 0, max: 1000, unit: '条' },
      { path: 'auto.audit_sample_rate', label: '人工抽检比例', kind: 'float', min: 0, max: 1, step: 0.05 },
      { path: 'auto.disable_on_any_incident', label: '任意异常立即关闭', kind: 'bool' },
    ],
  },
  {
    id: 'schedule',
    title: '调度',
    note: '只在谷时运行：工作日 12:00–14:00、18:00–次日 09:00，周末全天。',
    fields: [
      { path: 'schedule.only_offpeak', label: '只在谷时运行', kind: 'bool' },
      { path: 'schedule.weekend_all_day', label: '周末全天算谷时', kind: 'bool' },
      { path: 'schedule.windows.noon', label: '中午窗口', kind: 'timeRange' },
      { path: 'schedule.windows.night', label: '夜间窗口', kind: 'timeRange', help: '允许跨零点，例如 18:00 → 09:00。' },
      { path: 'schedule.session_max_minutes', label: '单次会话上限', kind: 'int', min: 5, max: 240, unit: '分钟' },
      { path: 'schedule.stop_write_before_end_min', label: '窗口结束前停止写操作', kind: 'int', min: 0, max: 60, unit: '分钟' },
    ],
  },
  {
    id: 'guard',
    title: '风控与拟人',
    note: '间隔随机、夜间静默、出错即停。不要把这些调成 0。',
    fields: [
      { path: 'guard.min_interval_sec', label: '通用最小间隔', kind: 'int', min: 1, max: 600, unit: '秒' },
      { path: 'guard.jitter_sec', label: '随机抖动区间', kind: 'numberRange', min: 0, max: 600, unit: '秒' },
      { path: 'guard.killed_file', label: '急停文件名', kind: 'string', maxLength: 32, help: '运行目录里出现这个文件即全停。' },
      { path: 'guard.cooldown_after_risk_days', label: '风控后冷却', kind: 'int', min: 0, max: 90, unit: '天' },
      { path: 'guard.cooldown_after_takedown_days', label: '下架后冷却', kind: 'int', min: 0, max: 365, unit: '天' },
      { path: 'guard.quiet_hours', label: '夜间静默', kind: 'timeRange' },
    ],
  },
];

export const FIELDS = new Map(PARAM_GROUPS.flatMap((group) => group.fields.map((field) => [field.path, field])));

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function asInt(value, field) {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { error: `${field.label} 必须是整数` };
  }
  if (field.min != null && value < field.min) return { error: `${field.label} 不能小于 ${field.min}` };
  if (field.max != null && value > field.max) return { error: `${field.label} 不能大于 ${field.max}` };
  return { value };
}

function asFloat(value, field) {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { error: `${field.label} 必须是数字` };
  }
  if (field.min != null && value < field.min) return { error: `${field.label} 不能小于 ${field.min}` };
  if (field.max != null && value > field.max) return { error: `${field.label} 不能大于 ${field.max}` };
  return { value };
}

function asTimeRange(value, field) {
  if (!Array.isArray(value) || value.length !== 2) {
    return { error: `${field.label} 需要两个时间` };
  }
  const [start, end] = value;
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
    return { error: `${field.label} 的时间格式应为 HH:MM` };
  }
  if (start === end) return { error: `${field.label} 的起止时间不能相同` };
  return { value: [start, end] };
}

export function normalizeField(field, raw) {
  switch (field.kind) {
    case 'bool':
      if (typeof raw !== 'boolean') return { error: `${field.label} 必须是布尔值` };
      if (field.locked !== undefined && raw !== field.locked) {
        return { error: `${field.label} 是硬约束，必须保持${field.locked ? '开启' : '关闭'}` };
      }
      return { value: raw };
    case 'int':
      return asInt(raw, field);
    case 'float':
      return asFloat(raw, field);
    case 'timeRange':
      return asTimeRange(raw, field);
    case 'numberRange': {
      if (!Array.isArray(raw) || raw.length !== 2) return { error: `${field.label} 需要两个数字` };
      const [low, high] = raw.map(Number);
      if (!Number.isFinite(low) || !Number.isFinite(high)) return { error: `${field.label} 必须是数字` };
      if (low > high) return { error: `${field.label} 的前一个数不能大于后一个` };
      if (field.min != null && low < field.min) return { error: `${field.label} 不能小于 ${field.min}` };
      if (field.max != null && high > field.max) return { error: `${field.label} 不能大于 ${field.max}` };
      return { value: [low, high] };
    }
    case 'enum':
      if (!field.options.some((option) => option.value === raw)) return { error: `${field.label} 取值无效` };
      return { value: raw };
    case 'multienum': {
      if (!Array.isArray(raw)) return { error: `${field.label} 需要数组` };
      const allowed = new Set(field.options.map((option) => option.value));
      const unique = [...new Set(raw)];
      if (unique.some((item) => !allowed.has(item))) return { error: `${field.label} 含无效选项` };
      return { value: unique };
    }
    case 'string':
      if (typeof raw !== 'string' || raw.trim() === '') return { error: `${field.label} 不能为空` };
      if (field.maxLength && raw.length > field.maxLength) return { error: `${field.label} 太长` };
      return { value: raw.trim() };
    default:
      return { error: `未知字段类型 ${field.kind}` };
  }
}

export function validatePatch(patch) {
  const errors = [];
  const warnings = [];
  const normalized = {};

  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { errors: ['请求体必须是参数对象'], warnings, patch: {} };
  }

  for (const [path, raw] of Object.entries(patch)) {
    const field = FIELDS.get(path);
    if (!field) {
      errors.push(`未知参数：${path}`);
      continue;
    }
    const result = normalizeField(field, raw);
    if (result.error) errors.push(result.error);
    else normalized[path] = result.value;
  }

  const get = (path, fallback) => (path in normalized ? normalized[path] : fallback);

  // Cross-field sanity checks only make sense with the effective values; the
  // caller passes the merged config in `base` via `validatePatchAgainst`.
  return { errors, warnings, patch: normalized };
}

export function crossCheck(effective) {
  const errors = [];
  const warnings = [];

  if (effective.l2) {
    if (effective.l2.dm_allowlist_only !== true) {
      errors.push('dm_allowlist_only 必须在 config.yaml 中保持 true（白名单是硬约束）');
    }
    if (effective.l2.dm_allow_links === true) {
      errors.push('dm_allow_links 必须为 false（私信禁止链接）');
    }
  }

  if (effective.review?.rule_engine !== true) {
    errors.push('review.rule_engine 必须为 true（规则引擎不可绕过）');
  }

  if (effective.auto?.enabled === true) {
    if (effective.auto.min_clean_days < 14) warnings.push('AUTO 已开启，但 min_clean_days 小于 14。');
    if (effective.auto.audit_sample_rate < 0.2) warnings.push('AUTO 已开启，但抽检比例低于 0.2。');
    if (effective.review?.human_required === true) {
      warnings.push('AUTO 已开启，但人工必经仍为 true：AUTO 白名单动作不会生效。');
    }
  }

  if (effective.l3?.enabled === true && effective.l3.dynamic_require_human !== true) {
    errors.push('L3 动态必须保留人工审核');
  }

  return { errors, warnings };
}
