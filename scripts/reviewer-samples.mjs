// Live reviewer sample runner.
//
// This is deliberately not part of `npm test`: it calls the configured real
// API and costs tokens. Use it after changing the reviewer prompt.
//
//   npm run review:test
//   npm run review:test -- --json
//   npm run review:test -- --strict

import { readFile } from 'node:fs/promises';
import { resolveReviewerTransport, reviewerStatus } from '../src/reviewer-config.mjs';
import { reviewContent } from '../src/reviewer.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const strict = args.includes('--strict');
const limitIndex = args.indexOf('--limit');
const limit = limitIndex === -1 ? null : Number(args[limitIndex + 1]);
const idIndex = args.indexOf('--id');
const ids = idIndex === -1 ? null : new Set(String(args[idIndex + 1] ?? '').split(',').map((value) => value.trim()).filter(Boolean));

const samples = JSON.parse(
  await readFile(new URL('../test/fixtures/reviewer-samples.json', import.meta.url), 'utf8'),
)
  .filter((sample) => !ids || ids.has(sample.id))
  .slice(0, Number.isInteger(limit) && limit > 0 ? limit : undefined);

const status = await reviewerStatus();
const transport = await resolveReviewerTransport();
if (!transport) {
  console.error('AI 审核器未配置（dry-run）。先在控制台「待审 → AI 审核器」保存 API，或设置 BILI_REVIEW_*。');
  process.exitCode = 2;
} else {
  const results = [];
  for (const sample of samples) {
    const review = await reviewContent(
      { content: sample.content, target: { bvid: 'BV1E7wtzaEdq' }, actionType: 'comment' },
      { transport, timeoutMs: 20_000 },
    );
    const accepted = Array.isArray(sample.expect) ? sample.expect : [sample.expect];
    results.push({
      id: sample.id,
      label: sample.label,
      expect: accepted,
      got: review.verdict,
      match: accepted.includes(review.verdict),
      risk: review.risk,
      reasons: review.reasons,
      suggest: review.suggest,
      elapsedMs: review.elapsedMs,
      error: Boolean(review.error),
    });
  }

  const summary = {
    total: results.length,
    matched: results.filter((item) => item.match).length,
    mismatched: results.filter((item) => !item.match).map((item) => item.id),
    errors: results.filter((item) => item.error).map((item) => item.id),
    mode: status.mode,
    model: status.model,
    endpointHost: status.endpointHost,
  };

  if (asJson) {
    console.log(JSON.stringify({ summary, results }, null, 2));
  } else {
    console.log(`AI 审核器样例：${summary.total} 条 · ${status.model} @ ${status.endpointHost}`);
    for (const [index, item] of results.entries()) {
      const mark = item.match ? 'OK  ' : 'MISS';
      console.log(
        `${String(index + 1).padStart(2)}. [${mark}] ${item.id.padEnd(16)} 期望 ${item.expect.join('/').padEnd(11)} 实际 ${String(item.got).padEnd(6)} risk=${item.risk} ${Math.round(item.elapsedMs / 1000)}s`,
      );
      for (const reason of item.reasons ?? []) console.log(`    - ${reason}`);
    }
    console.log(`\n匹配 ${summary.matched}/${summary.total}${summary.mismatched.length ? `；不一致：${summary.mismatched.join(', ')}` : '；全部符合预期'}`);
    if (summary.errors.length) console.log(`调用失败：${summary.errors.join(', ')}`);
  }

  if (strict && summary.mismatched.length > 0) process.exitCode = 1;
}
