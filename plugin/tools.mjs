// DSH host tools for the read-only half of bili-duty.
//
// These registrations deliberately avoid `@deepseek-ai/dsh-tools` (the linked
// plugin has no dependency on the host package): the registry accepts raw
// JSON-Schema definitions, so the tool surface stays dependency-free.

import { readStatus, readVideo, searchVideos } from '../src/read.mjs';
import { readWatched } from '../src/memory.mjs';
import { loadConfig } from '../src/config.mjs';
import { runtimePaths } from '../src/paths.mjs';
import { draftComment } from '../src/review-flow.mjs';

const text = (value) => [{ type: 'text', text: value }];

function object(properties, required = []) {
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

function array(items) {
  return { type: 'array', items };
}

function unwrap(result) {
  if (result?.ok) return result;
  const errors = Array.isArray(result?.errors) && result.errors.length ? result.errors : ['读取失败'];
  throw new Error(errors.join('；'));
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function renderSearch(value) {
  const lines = [`「${value.query}」 · ${value.items.length} 个视频`];
  value.items.forEach((item, index) => {
    const facts = [item.author, item.duration, item.play ? `${item.play} 播放` : ''].filter(Boolean).join(' · ');
    lines.push(`${index + 1}. ${item.title}`);
    lines.push(`   ${item.bvid} · ${facts}`);
    lines.push(`   ${item.url}`);
  });
  return lines.join('\n');
}

function renderVideo(value) {
  const video = value.video;
  const lines = [video.title];
  lines.push(
    [
      value.bvid,
      video.author ? `UP ${video.author}` : '',
      video.duration || '',
      video.view ? `播放 ${video.view}` : '',
      video.like ? `点赞 ${video.like}` : '',
      value.commentsTotal ? `评论 ${value.commentsTotal}` : '',
      value.sort === 'time' ? '按最新' : '按最热',
    ]
      .filter(Boolean)
      .join(' · '),
  );
  if (video.desc) lines.push('', video.desc);
  lines.push('', `已读取 ${value.comments.length} 条评论：`);
  value.comments.forEach((comment, index) => {
    const meta = [comment.author || '匿名', comment.pubdate, comment.likes ? `${comment.likes} 赞` : '']
      .filter(Boolean)
      .join(' · ');
    lines.push(`${index + 1}. ${meta}`);
    lines.push(comment.text);
    if (comment.replies) lines.push(`（${comment.replies} 条回复）`);
  });
  if (value.memory) lines.push('', `记忆已写入：${value.memory.watched}`);
  return lines.join('\n');
}

function renderWatched(value) {
  const lines = [`看过 ${value.total} 个视频 · ${value.file}`];
  if (!value.entries.length) lines.push('（还没有记录）');
  for (const entry of value.entries) {
    lines.push(`- ${entry.ts}  ${entry.title || entry.bvid}  ${entry.bvid}`);
    if (entry.note) lines.push(`  笔记：${entry.note}`);
  }
  return lines.join('\n');
}

function renderDraft(value) {
  return [
    `草稿 ${value.draftId} · ${value.status}`,
    `视频：${value.target}`,
    `规则：${value.ruleVerdict}${value.risk ? `（${value.risk}）` : ''}`,
    `AI：${value.aiVerdict}`,
    value.reasons.length ? `原因：${value.reasons.join('；')}` : '',
    '人工批准后才会执行；不会自动发布。',
    '',
    value.content,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderStatus(value) {
  return [
    `Chrome：${value.cdp ? `已连接（端口 ${value.port}）` : '未启动'}`,
    `B 站登录：${value.loggedIn ? `UID ${value.uid}` : '未登录'}`,
    `只读记忆：${value.memory.total} 个视频`,
    `最近一小时导航：${value.navigationsLastHour} 次`,
    value.stop ? `急停：${value.stop.file}` : '急停：未触发',
    ...(value.config.errors?.length ? [`配置错误：${value.config.errors.join('；')}`] : []),
  ].join('\n');
}

/**
 * Build the raw tool definitions. Exported for tests and for the host plugin.
 * `deps` is injectable so tests never touch Chrome.
 */
export function createBiliTools({
  port = 9222,
  search = searchVideos,
  read = readVideo,
  status = readStatus,
  watched = readWatched,
  draft = draftComment,
} = {}) {
  return [
    {
      name: 'bili_status',
      description:
        '检查 bili-duty 的只读链路：Chrome/CDP、B 站登录态、STOP 急停、只读记忆数量。不会操作 B 站页面。',
      parameters: object({}),
      output: {
        schema: object(
          {
            port: { type: 'integer' },
            cdp: { type: 'boolean' },
            loggedIn: { type: 'boolean' },
            uid: { type: 'integer' },
            memory: object(
              {
                total: { type: 'integer' },
                file: { type: 'string' },
                missing: { type: 'boolean' },
              },
              ['total', 'file', 'missing'],
            ),
            navigationsLastHour: { type: 'integer' },
            stop: object({ file: { type: 'string' } }, ['file']),
            config: object({ errors: array({ type: 'string' }) }, ['errors']),
          },
          ['port', 'cdp', 'loggedIn', 'memory', 'navigationsLastHour', 'config'],
        ),
        render: (_args, value) => text(renderStatus(value)),
      },
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      async execute() {
        const ready = await status({ port });
        return compact({
          port: ready.port,
          cdp: ready.cdp,
          loggedIn: ready.loggedIn,
          uid: ready.uid ?? undefined,
          memory: {
            total: ready.memory.total,
            file: ready.memory.file,
            missing: Boolean(ready.memory.missing),
          },
          navigationsLastHour: ready.navigationsLastHour,
          stop: ready.stop ? { file: ready.stop.file } : undefined,
          config: { errors: ready.config.errors ?? [] },
        });
      },
    },
    {
      name: 'bili_search',
      description:
        '只读搜索 B 站视频：返回 BV 号、标题、UP 主、时长、播放量。不会点赞、投币、收藏、评论或私信；导航受本机限速。',
      parameters: object(
        {
          query: { type: 'string', description: '搜索关键词，1–50 字' },
          limit: { type: 'integer', description: '返回条数，1–10，默认 5' },
        },
        ['query'],
      ),
      output: {
        schema: object(
          {
            query: { type: 'string' },
            url: { type: 'string' },
            loginUid: { type: 'integer' },
            tookMs: { type: 'integer' },
            items: array(
              object(
                {
                  bvid: { type: 'string' },
                  title: { type: 'string' },
                  author: { type: 'string' },
                  authorUid: { type: 'integer' },
                  play: { type: 'string' },
                  danmaku: { type: 'string' },
                  duration: { type: 'string' },
                  pubdate: { type: 'string' },
                  url: { type: 'string' },
                },
                ['bvid', 'title', 'url'],
              ),
            ),
          },
          ['query', 'url', 'items'],
        ),
        render: (_args, value) => text(renderSearch(value)),
      },
      timeoutMs: 120_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const result = unwrap(await search(args.query, { limit: args.limit ?? 5, port }));
        return {
          query: result.query,
          url: result.url,
          loginUid: result.loginUid ?? undefined,
          tookMs: result.tookMs,
          items: result.items.map((item) =>
            compact({
              bvid: item.bvid,
              title: item.title,
              author: item.author,
              authorUid: item.authorUid ?? undefined,
              play: item.play,
              danmaku: item.danmaku,
              duration: item.duration,
              pubdate: item.pubdate,
              url: item.url,
            }),
          ),
        };
      },
    },
    {
      name: 'bili_read_video',
      description:
        '只读打开一个 B 站视频，返回视频信息和评论区（Shadow DOM），并写入本机只读记忆 runtime/memory。不会点赞、评论、投币或私信；导航受本机限速。',
      parameters: object(
        {
          bvid: { type: 'string', description: 'BV 号或完整视频链接' },
          comments: { type: 'integer', description: '读取评论条数，0–50，默认 20' },
          order: { type: 'string', enum: ['hot', 'new'], description: '评论排序，默认 hot' },
          note: { type: 'string', description: '可选：给这次阅读写一句笔记，会进入当天笔记' },
        },
        ['bvid'],
      ),
      output: {
        schema: object(
          {
            bvid: { type: 'string' },
            video: object(
              {
                title: { type: 'string' },
                author: { type: 'string' },
                authorUid: { type: 'integer' },
                view: { type: 'string' },
                danmaku: { type: 'string' },
                like: { type: 'string' },
                coin: { type: 'string' },
                favorite: { type: 'string' },
                share: { type: 'string' },
                duration: { type: 'string' },
                pubdate: { type: 'string' },
                desc: { type: 'string' },
                tags: array({ type: 'string' }),
                url: { type: 'string' },
              },
              ['title', 'author', 'view', 'like', 'desc', 'tags', 'url'],
            ),
            comments: array(
              object(
                {
                  author: { type: 'string' },
                  authorUid: { type: 'integer' },
                  text: { type: 'string' },
                  pubdate: { type: 'string' },
                  likes: { type: 'integer' },
                  replies: { type: 'integer' },
                },
                ['author', 'text', 'pubdate', 'likes', 'replies'],
              ),
            ),
            commentsTotal: { type: 'string' },
            commentsLoaded: { type: 'integer' },
            sort: { type: 'string' },
            memory: object(
              {
                watched: { type: 'string' },
                note: { type: 'string' },
              },
              ['watched', 'note'],
            ),
            tookMs: { type: 'integer' },
          },
          ['bvid', 'video', 'comments', 'sort'],
        ),
        render: (_args, value) => text(renderVideo(value)),
      },
      timeoutMs: 180_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const result = unwrap(
          await read(args.bvid, {
            comments: args.comments ?? 20,
            order: args.order ?? 'hot',
            note: args.note ?? '',
            port,
          }),
        );
        return {
          bvid: result.bvid,
          video: compact({
            title: result.video.title,
            author: result.video.author,
            authorUid: result.video.authorUid ?? undefined,
            view: result.video.view,
            danmaku: result.video.danmaku,
            like: result.video.like,
            coin: result.video.coin,
            favorite: result.video.favorite,
            share: result.video.share,
            duration: result.video.duration,
            pubdate: result.video.pubdate,
            desc: result.video.desc,
            tags: result.video.tags ?? [],
            url: result.video.url,
          }),
          comments: result.comments.map((comment) =>
            compact({
              author: comment.author,
              authorUid: comment.authorUid ?? undefined,
              text: comment.text,
              pubdate: comment.pubdate,
              likes: comment.likes,
              replies: comment.replies,
            }),
          ),
          commentsTotal: result.commentsTotal || '',
          commentsLoaded: result.commentsLoaded,
          sort: result.sort,
          memory: result.memory
            ? { watched: result.memory.watched, note: result.memory.note }
            : undefined,
          tookMs: result.tookMs,
        };
      },
    },
    {
      name: 'bili_draft_comment',
      description:
        '为一个 B 站视频创建评论草稿：先过确定性规则和独立 AI 审核，再进入控制台「待审」页。只写本机草稿，不会发布评论；必须由人工在控制台批准后才会执行。',
      parameters: object(
        {
          bvid: { type: 'string', description: 'BV 号或完整视频链接' },
          content: { type: 'string', description: '评论草稿；缺失 @主人 时会自动补上' },
          note: { type: 'string', description: '可选：给审核/人工看的一句备注' },
        },
        ['bvid', 'content'],
      ),
      output: {
        schema: object(
          {
            draftId: { type: 'string' },
            status: { type: 'string' },
            target: { type: 'string' },
            content: { type: 'string' },
            ruleVerdict: { type: 'string' },
            aiVerdict: { type: 'string' },
            risk: { type: 'string' },
            reasons: array({ type: 'string' }),
            requiresHuman: { type: 'boolean' },
            note: { type: 'string' },
          },
          ['draftId', 'status', 'target', 'content', 'ruleVerdict', 'aiVerdict', 'risk', 'reasons', 'requiresHuman'],
        ),
        render: (_args, value) => text(renderDraft(value)),
      },
      timeoutMs: 120_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const result = await draft({ bvid: args.bvid, content: args.content, note: args.note ?? '' });
        if (!result.ok) throw new Error((result.errors ?? ['草稿被拒绝']).join('；'));
        return {
          draftId: result.draft.id,
          status: result.draft.status,
          target: result.draft.target?.bvid ?? args.bvid,
          content: result.draft.content,
          ruleVerdict: result.rule?.verdict ?? 'human',
          aiVerdict: result.ai?.verdict ?? 'human',
          risk: result.ai?.risk ?? result.rule?.risk ?? 'medium',
          reasons: [...(result.rule?.reasons ?? []), ...(result.ai?.reasons ?? [])],
          requiresHuman: true,
          note: result.draft.meta?.note ?? '',
        };
      },
    },
    {
      name: 'bili_watched',
      description: '读取本机只读记忆：最近看过哪些 B 站视频、读了多少评论。不会访问 B 站。',
      parameters: object({
        limit: { type: 'integer', description: '返回条数，1–100，默认 20' },
      }),
      output: {
        schema: object(
          {
            total: { type: 'integer' },
            file: { type: 'string' },
            missing: { type: 'boolean' },
            entries: array(
              object(
                {
                  ts: { type: 'string' },
                  bvid: { type: 'string' },
                  title: { type: 'string' },
                  author: { type: 'string' },
                  commentsRead: { type: 'integer' },
                  note: { type: 'string' },
                  url: { type: 'string' },
                },
                ['ts', 'bvid'],
              ),
            ),
          },
          ['total', 'file', 'missing', 'entries'],
        ),
        render: (_args, value) => text(renderWatched(value)),
      },
      timeoutMs: 15_000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const config = await loadConfig();
        const paths = runtimePaths(config.data);
        const data = await watched(paths.memory, args.limit ?? 20);
        return {
          total: data.total,
          file: data.file,
          missing: Boolean(data.missing),
          entries: (data.entries ?? []).map((entry) =>
            compact({
              ts: entry.ts,
              bvid: entry.bvid,
              title: entry.title,
              author: entry.author,
              commentsRead: entry.commentsRead,
              note: entry.note,
              url: entry.url,
            }),
          ),
        };
      },
    },
  ];
}

/** Register every read-only tool on a DSH host context. */
export function registerBiliTools(ctx, options = {}) {
  const tools = createBiliTools(options);
  if (!ctx?.tools?.register) throw new Error('DSH tools 服务不可用，无法注册 B 站只读工具');
  for (const tool of tools) ctx.tools.register(tool);
  return tools.map((tool) => tool.name);
}
