// Draft → rules → independent reviewer → human approval queue.
// Nothing here touches B站; execution is a separate, token-gated step.

import { loadConfig } from './config.mjs';
import { runtimePaths } from './paths.mjs';
import { guardWrite } from './write-guard.mjs';
import { reviewContent, reviewerFromEnv } from './reviewer.mjs';
import { createDraft } from './approvals.mjs';

/**
 * Create a comment draft. The deterministic rule layer may reject it; the AI
 * reviewer may reject it; otherwise it enters the human queue as `pending`.
 */
export async function draftComment({
  bvid,
  content,
  note = '',
  now = new Date(),
  draftsDir,
  reviewTransport,
  config: overrideConfig,
  allowlist,
  entries,
  home,
} = {}) {
  const config = overrideConfig ?? (await loadConfig());
  const cfg = config.data ?? config;
  const paths = runtimePaths(cfg);
  const dir = draftsDir ?? paths.drafts;

  const rule = await guardWrite({
    action: 'comment',
    content,
    target: { bvid },
    config: cfg,
    allowlist,
    entries,
    now,
    home: home ?? paths.home,
    skipWindow: true,
  });
  if (rule.verdict === 'reject') {
    return { ok: false, errors: rule.reasons, rule, ai: null };
  }

  const transport = reviewTransport === undefined ? reviewerFromEnv() : reviewTransport;
  const ai = await reviewContent(
    { content: rule.text, target: rule.target, actionType: 'comment' },
    { transport },
  );
  if (ai.verdict === 'reject') {
    return { ok: false, errors: ai.reasons.length ? ai.reasons : ['AI 审核拒绝'], rule, ai };
  }

  const created = await createDraft(
    {
      action: 'comment',
      target: rule.target,
      content: rule.text,
      rule,
      ai,
      meta: { note: String(note ?? '').slice(0, 300), humanRequired: true },
    },
    { draftsDir: dir, now },
  );
  if (!created.ok) return { ok: false, errors: created.errors, rule, ai };

  return {
    ok: true,
    draft: created.draft,
    rule,
    ai,
    requiresHuman: true,
    reason:
      rule.verdict === 'human'
        ? '规则引擎要求人工判断'
        : ai.verdict === 'human'
          ? 'AI 审核器转人工'
          : '人工审批后才会执行',
  };
}
