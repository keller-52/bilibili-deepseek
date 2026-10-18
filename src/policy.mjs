// Comment mention policy: the owner is the only person a public comment may
// mention. There is no comment executor yet; stage 3 will call this before it
// types into the comment box.

export function extractMentions(text) {
  return [...String(text ?? '').matchAll(/@([A-Za-z0-9_\-\u4e00-\u9fa5]+)/g)].map((match) => match[1]);
}

/**
 * Returns the normalized comment text, prefixing `@owner` when missing.
 * Refuses any mention of someone other than the owner.
 */
export function ensureOwnerMention(text, owner) {
  if (!owner || !owner.name) {
    return { ok: false, errors: ['白名单里还没有标记主人（owner）'] };
  }

  const content = String(text ?? '').trim();
  if (!content) return { ok: false, errors: ['评论内容不能为空'] };

  const mentions = extractMentions(content);
  const foreign = mentions.filter((name) => name !== owner.name);
  if (foreign.length) {
    return {
      ok: false,
      errors: [`评论只能 @ 主人 ${owner.name}，不能 @ 其他人（${foreign.join('、')}）`],
    };
  }

  const added = mentions.length === 0;
  return {
    ok: true,
    text: added ? `@${owner.name} ${content}` : content,
    added,
    mentions,
  };
}
