// Independent content reviewer (layer 2).
//
// The reviewer is deliberately stateless: it sees only the content, target and
// action type, never the generating agent's conversation, persona or reasons.
// Any transport failure, timeout, malformed JSON or missing reason fails
// closed to `human` -- never to `pass`.

const VERDICTS = new Set(['pass', 'human', 'reject']);
const RISKS = new Set(['low', 'medium', 'high']);

export const REVIEW_SYSTEM_PROMPT = `你是内容审核器。你不认识作者，不知道上下文，只判断这段文字作为 B 站公开评论/私信是否合适。
只输出 JSON，不解释。不要评价文笔、技术含量，也不要求内容“有用”；但要判断它有没有越界给专业建议。
先检查硬拒绝项；命中就 reject，不管语气多可爱。

拒绝：
- 政治敏感：涉及时政、政策评价、政府/领导人/历史争议的内容，即使只是泛泛一句、语气温和，也 reject；
- 违法、色情、赌博、毒品、诈骗、破解、翻墙教程；
- 医疗、法律、金融、心理、教育、工程安全等非编程/AI 领域的专业建议或结论：
  诊断、处方、剂量、法律意见、投资荐股、理财承诺、心理评估、教学处方等；明确建议就 reject；
- 人身攻击、辱骂、地域/性别/民族/职业歧视、骚扰、挂人、网暴、泄露隐私；
- 引战、拉踩、带节奏、挑动对立；
- 广告引流：站外链接、联系方式、二维码、拉群、代购、优惠下单、引流私聊；
- 冒充：假称真人亲历、官方/客服/内部人员；但承认“我是 AI / 小深”不算冒充；
- 虚假事实、伪造来源、过度承诺（保证/百分百/稳赚/一定能）；
- 低质刷屏：纯复读、无意义字符、复制粘贴。短感叹、单个表情、颜文字不算。

边界说明：
- 编程、AI、工具、开源方向的技术观察或建议可以 pass，这不算“专业建议”；
- 其他领域的共情、祝福、个人感受可以 pass，例如“抱抱，希望早点好起来，还是听医生的”；
  但不要给诊断、处方、法律结论或投资建议；
- 卖萌、撒娇、玩笑、轻松吐槽、夸夸、短句互动、表情/颜文字可以 pass；
  例如“呜哇这个也太可爱了”“被最后一句话戳到了，抱抱”“小深先码住～”；
- 不要因为内容“不技术 / 不专业 / 太可爱 / 太日常”而拒绝。

存疑（human）：
- 涉及具体数字/时间/人名但无法核实；
- 语气激烈、反讽、可能被误读为事实断言；
- 性暗示或过度亲密、但未到露骨程度；
- 长度超过 100 字；
- 对非编程/AI 领域下模糊的专业判断，例如“这大概率是抑郁症”“这个合同肯定无效”。

通过（pass）：
- 编程、AI、工具、开源相关技术观察或建议；
- 感谢、回答提问、日常记录；
- 卖萌、撒娇、玩笑、轻松吐槽、共情、夸夸、短句互动、表情/颜文字；
- 只要不命中硬拒绝项、不冒充真人、不泄露隐私，且不超过 100 字。

风险：pass=low，human=medium，reject=high。reasons 至少一条，简短说明。

JSON 格式：
{"verdict":"pass"|"human"|"reject","risk":"low"|"medium"|"high","reasons":["..."],"suggest":"可选改写建议"}`;

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'human', 'reject'] },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    reasons: { type: 'array', items: { type: 'string' } },
    suggest: { type: 'string' },
  },
  required: ['verdict', 'risk', 'reasons'],
};

function parseJsonText(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  let text = String(raw ?? '').trim();
  if (!text) throw new Error('审核器没有返回内容');
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('审核器返回的不是合法 JSON');
  }
}

/** Validate and normalise one reviewer payload. Throws on unsafe shapes. */
export function validateReviewPayload(raw) {
  const value = parseJsonText(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('审核器输出必须是 JSON 对象');
  }
  if (!VERDICTS.has(value.verdict)) throw new Error(`审核器 verdict 无效：${value.verdict}`);
  if (!RISKS.has(value.risk)) throw new Error(`审核器 risk 无效：${value.risk}`);
  if (!Array.isArray(value.reasons) || value.reasons.some((reason) => typeof reason !== 'string')) {
    throw new Error('审核器 reasons 必须是字符串数组');
  }
  if (value.suggest !== undefined && typeof value.suggest !== 'string') {
    throw new Error('审核器 suggest 必须是字符串');
  }
  if (value.verdict === 'pass' && value.risk === 'high') {
    return { ...value, verdict: 'human', reasons: [...value.reasons, 'risk=high 时 pass 降级为 human'] };
  }
  if (value.verdict === 'pass' && value.reasons.length === 0) {
    return { ...value, verdict: 'human', reasons: ['审核器没有给出通过理由，转人工'] };
  }
  return value;
}

function timeoutSignal(timeoutMs, outerSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('审核器超时')), timeoutMs);
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort(outerSignal.reason);
    else outerSignal.addEventListener('abort', () => controller.abort(outerSignal.reason), { once: true });
  }
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

function reviewPrompt({ content, target, actionType }) {
  return JSON.stringify(
    {
      content: String(content ?? ''),
      target: target ?? null,
      action_type: String(actionType ?? 'comment'),
    },
    null,
    2,
  );
}

/**
 * Ask the independent reviewer. `transport` receives `{ system, prompt, schema,
 * signal }` and returns raw model text (or an already-parsed object).
 * Without a transport this is a safe dry run that always returns `human`.
 */
export async function reviewContent(
  { content, target, actionType = 'comment' },
  { transport, timeoutMs = 20_000, signal } = {},
) {
  const started = Date.now();
  if (typeof transport !== 'function') {
    return {
      verdict: 'human',
      risk: 'medium',
      reasons: ['AI 审核器未配置（dry-run），转人工'],
      suggest: '',
      dryRun: true,
      model: null,
      elapsedMs: 0,
    };
  }

  const boundedTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 20_000;
  const deadline = timeoutSignal(boundedTimeout, signal);
  let timer = null;
  try {
    const raw = await Promise.race([
      transport({
        system: REVIEW_SYSTEM_PROMPT,
        prompt: reviewPrompt({ content, target, actionType }),
        schema: REVIEW_SCHEMA,
        signal: deadline.signal,
      }),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`审核器超时（${boundedTimeout}ms）`)), boundedTimeout + 50);
      }),
    ]);
    const payload = validateReviewPayload(raw);
    return {
      ...payload,
      dryRun: false,
      model: null,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    return {
      verdict: 'human',
      risk: 'medium',
      reasons: [`审核器失败，转人工：${error.message}`],
      suggest: '',
      dryRun: false,
      error: true,
      elapsedMs: Date.now() - started,
    };
  } finally {
    if (timer) clearTimeout(timer);
    deadline.clear();
  }
}

/**
 * OpenAI-compatible chat transport. No provider SDK is added; callers supply
 * endpoint, key and model. The reviewer still needs only the fixed prompt.
 */
export function createHttpReviewerTransport({ endpoint, apiKey, model = 'deepseek-chat', fetchImpl = fetch } = {}) {
  if (!endpoint) throw new Error('审核器 endpoint 不能为空');
  return async function httpTransport({ system, prompt, signal }) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
      signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`审核器 HTTP ${response.status}${detail ? `：${detail.slice(0, 160)}` : ''}`);
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('审核器响应缺少 choices[0].message.content');
    return content;
  };
}

/** Build a transport from environment variables; null keeps dry-run mode. */
export function reviewerFromEnv(env = process.env) {
  const endpoint = env.BILI_REVIEW_API_URL || (env.BILI_REVIEW_API_KEY ? 'https://api.deepseek.com/chat/completions' : '');
  if (!endpoint) return null;
  return createHttpReviewerTransport({
    endpoint,
    apiKey: env.BILI_REVIEW_API_KEY || '',
    model: env.BILI_REVIEW_MODEL || 'deepseek-chat',
  });
}

/** Used by tests and the console preview to count reviewer outcomes. */
export function summarizeReview(review) {
  if (!review || typeof review !== 'object') return 'human';
  if (!VERDICTS.has(review.verdict)) return 'human';
  return review.verdict;
}
