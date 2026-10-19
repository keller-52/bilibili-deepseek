import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  REVIEW_SCHEMA,
  REVIEW_SYSTEM_PROMPT,
  createHttpReviewerTransport,
  reviewContent,
  reviewerFromEnv,
  summarizeReview,
  validateReviewPayload,
} from '../src/reviewer.mjs';

const pass = { verdict: 'pass', risk: 'low', reasons: ['技术观察，长度正常'] };

test('reviewer without a transport fails closed to human (dry-run)', async () => {
  const review = await reviewContent({ content: '你好', target: { bvid: 'BV1E7wtzaEdq' } });
  assert.equal(review.verdict, 'human');
  assert.equal(review.dryRun, true);
  assert.match(review.reasons[0], /未配置/);
});

test('valid reviewer payloads are accepted', async () => {
  const review = await reviewContent(
    { content: '这个讲得清楚', target: { bvid: 'BV1E7wtzaEdq' }, actionType: 'comment' },
    { transport: async () => pass },
  );
  assert.equal(review.verdict, 'pass');
  assert.equal(review.dryRun, false);
  assert.equal(review.risk, 'low');
});

test('a high-risk pass is downgraded to human', () => {
  const value = validateReviewPayload({ verdict: 'pass', risk: 'high', reasons: ['有点激烈'] });
  assert.equal(value.verdict, 'human');
  assert.match(value.reasons.at(-1), /risk=high/);
});

test('pass without reasons is downgraded to human', () => {
  const value = validateReviewPayload({ verdict: 'pass', risk: 'low', reasons: [] });
  assert.equal(value.verdict, 'human');
});

test('malformed or unsafe reviewer output fails closed', async () => {
  const cases = [
    async () => 'not json',
    async () => ({ verdict: 'yes', risk: 'low', reasons: ['x'] }),
    async () => ({ verdict: 'pass', risk: 'extreme', reasons: ['x'] }),
    async () => ({ verdict: 'pass', risk: 'low', reasons: 'not-array' }),
    async () => {
      throw new Error('provider down');
    },
  ];
  for (const transport of cases) {
    const review = await reviewContent({ content: '你好' }, { transport, timeoutMs: 1000 });
    assert.equal(review.verdict, 'human');
    assert.ok(review.reasons.length > 0);
  }
});

test('reviewer timeout fails closed', async () => {
  const review = await reviewContent(
    { content: '你好' },
    {
      transport: () => new Promise(() => {}),
      timeoutMs: 30,
    },
  );
  assert.equal(review.verdict, 'human');
  assert.match(review.reasons.join('；'), /超时/);
});

test('JSON code fences are tolerated', () => {
  const value = validateReviewPayload('```json\n{"verdict":"reject","risk":"high","reasons":["广告"]}\n```');
  assert.equal(value.verdict, 'reject');
});

test('the reviewer prompt keeps generation and review separate', () => {
  assert.match(REVIEW_SYSTEM_PROMPT, /不知道上下文/);
  assert.match(REVIEW_SYSTEM_PROMPT, /只输出 JSON/);
  assert.deepEqual(REVIEW_SCHEMA.required, ['verdict', 'risk', 'reasons']);
});

test('reviewer prompt allows playful non-technical content but keeps hard rejects', () => {
  assert.match(REVIEW_SYSTEM_PROMPT, /卖萌/);
  assert.match(REVIEW_SYSTEM_PROMPT, /撒娇/);
  assert.match(REVIEW_SYSTEM_PROMPT, /不技术/);
  assert.match(REVIEW_SYSTEM_PROMPT, /不要因为内容/);
  assert.match(REVIEW_SYSTEM_PROMPT, /短感叹.*不算/);
  assert.match(REVIEW_SYSTEM_PROMPT, /我是 AI.*不算冒充|承认.*AI.*不算冒充/);
  for (const hard of ['政治敏感', '广告引流', '人身攻击', '医疗', '投资', '低质刷屏', '过度承诺']) {
    assert.match(REVIEW_SYSTEM_PROMPT, new RegExp(hard));
  }
  assert.match(REVIEW_SYSTEM_PROMPT, /政策评价/);
  assert.match(REVIEW_SYSTEM_PROMPT, /即使只是泛泛一句/);
  assert.match(REVIEW_SYSTEM_PROMPT, /非编程\/AI 领域/);
  assert.match(REVIEW_SYSTEM_PROMPT, /诊断、处方、剂量、法律意见/);
  assert.match(REVIEW_SYSTEM_PROMPT, /编程、AI、工具、开源/);
  assert.match(REVIEW_SYSTEM_PROMPT, /reasons 至少一条/);
});

test('the live reviewer sample fixture is well formed', async () => {
  const samples = JSON.parse(await readFile(new URL('./fixtures/reviewer-samples.json', import.meta.url), 'utf8'));
  assert.ok(samples.length >= 8);
  assert.equal(new Set(samples.map((sample) => sample.id)).size, samples.length);
  for (const sample of samples) {
    assert.match(sample.id, /^[a-z0-9-]+$/);
    const accepted = Array.isArray(sample.expect) ? sample.expect : [sample.expect];
    assert.ok(accepted.length > 0);
    assert.ok(accepted.every((value) => ['pass', 'human', 'reject'].includes(value)));
    assert.ok(sample.content.length > 0);
    assert.ok(sample.content.length <= 300);
  }
  assert.ok(
    samples.some((sample) => {
      const accepted = Array.isArray(sample.expect) ? sample.expect : [sample.expect];
      return accepted.includes('pass') && /可爱|抱抱|哈哈/.test(sample.content);
    }),
  );
  assert.ok(
    samples.some((sample) => {
      const accepted = Array.isArray(sample.expect) ? sample.expect : [sample.expect];
      return accepted.includes('reject') && /加微信/.test(sample.content);
    }),
  );
});

test('HTTP transport posts a fixed prompt and parses the response', async () => {
  let request = null;
  const transport = createHttpReviewerTransport({
    endpoint: 'https://review.example/chat',
    apiKey: 'secret',
    model: 'review-model',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: JSON.stringify(pass) } }] };
        },
      };
    },
  });
  const review = await reviewContent({ content: '这个讲得清楚' }, { transport, timeoutMs: 1000 });
  assert.equal(review.verdict, 'pass');
  assert.equal(request.url, 'https://review.example/chat');
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'review-model');
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /内容审核器/);
});

test('HTTP errors and empty responses fail closed', async () => {
  const badStatus = createHttpReviewerTransport({
    endpoint: 'https://review.example/chat',
    fetchImpl: async () => ({ ok: false, status: 500, async text() { return 'boom'; } }),
  });
  const first = await reviewContent({ content: '你好' }, { transport: badStatus, timeoutMs: 1000 });
  assert.equal(first.verdict, 'human');

  const empty = createHttpReviewerTransport({
    endpoint: 'https://review.example/chat',
    fetchImpl: async () => ({ ok: true, async json() { return { choices: [] }; } }),
  });
  const second = await reviewContent({ content: '你好' }, { transport: empty, timeoutMs: 1000 });
  assert.equal(second.verdict, 'human');
});

test('reviewerFromEnv stays dry without an endpoint', () => {
  assert.equal(reviewerFromEnv({}), null);
  assert.equal(typeof reviewerFromEnv({ BILI_REVIEW_API_URL: 'https://review.example/chat' }), 'function');
  assert.equal(typeof reviewerFromEnv({ BILI_REVIEW_API_KEY: 'key' }), 'function');
});

test('summarizeReview defaults unknown values to human', () => {
  assert.equal(summarizeReview(pass), 'pass');
  assert.equal(summarizeReview({ verdict: 'yes' }), 'human');
  assert.equal(summarizeReview(null), 'human');
});

test('offline sample set matches the rule engine decisions', async () => {
  const samples = JSON.parse(await readFile(new URL('./fixtures/review-samples.json', import.meta.url), 'utf8'));
  const { guardWrite } = await import('../src/write-guard.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bili-samples-'));
  const offpeak = new Date(2026, 9, 19, 20, 0, 0);
  const owner = { uid: 1511387074, name: 'Kylume', owner: true };
  const config = {
    schedule: { only_offpeak: true, weekend_all_day: true, windows: { noon: ['12:00', '14:00'], night: ['18:00', '09:00'] }, stop_write_before_end_min: 10 },
    l1: { like_per_day: 20, coin_per_day: 1, favorite_per_day: 10 },
    l2: {
      comment_per_video: 1, reply_per_root: 2, comment_per_day: 3, reply_per_day: 10, total_per_day: 10,
      per_person_per_day: 1, comment_min_interval_sec: 600, danmaku_per_day: 5,
      dm_per_day: 10, dm_per_person_per_day: 3, dm_min_interval_sec: 300, dm_allow_links: false,
    },
    l3: { enabled: false, dynamic_per_day: 1 },
    review: { rule_engine: true, human_required: true },
    guard: { quiet_hours: ['00:00', '07:00'], killed_file: 'STOP' },
  };
  try {
    for (const sample of samples) {
      const result = await guardWrite({
        action: sample.action,
        content: sample.content,
        target: sample.target ?? { bvid: 'BV1E7wtzaEdq' },
        config,
        allowlist: { allow: [owner] },
        entries: [],
        now: offpeak,
        home: dir,
      });
      assert.equal(result.verdict, sample.expectRule, `${sample.id}: ${result.reasons.join('；')}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
