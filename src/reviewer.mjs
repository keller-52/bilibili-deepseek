// Independent content reviewer (layer 2).
//
// The reviewer is deliberately stateless: it sees only the content, target and
// action type, never the generating agent's conversation, persona or reasons.
// Any transport failure, timeout, malformed JSON or missing reason fails
// closed to `human` -- never to `pass`.

const VERDICTS = new Set(['pass', 'human', 'reject']);
const RISKS = new Set(['low', 'medium', 'high']);

export const REVIEW_SYSTEM_PROMPT = `你是内容审核器。你不认识作者，不知道上下文，只判断这段文字能不能发在公开评论区/私信里。
只输出 JSON，不解释。
拒绝：引战、人身攻击、地域/性别/民族歧视、政治敏感、医疗/法律/投资建议、
      广告引流、外链、冒充真人、虚假事实、过度承诺、低质刷屏。
存疑：涉及具体数字/时间/人名但无法验证、语气激烈、长度异常。
通过：技术观察、感谢、回答提问、日常记录，且 ≤100 字。

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
