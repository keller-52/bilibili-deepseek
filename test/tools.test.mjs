import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBiliTools, registerBiliTools } from '../plugin/tools.mjs';

const sampleVideo = {
  title: '从 LLM 到 Agent Skill',
  author: '马克的技术工作坊',
  authorUid: 1815948385,
  view: '211.3万',
  danmaku: '2894',
  like: '10.4万',
  coin: '7.1万',
  favorite: '18.1万',
  share: '3.5万',
  pubdate: '2026-03-14',
  desc: '一段简介',
  tags: ['AI', 'Agent'],
  url: 'https://www.bilibili.com/video/BV1E7wtzaEdq',
};

const sampleComment = {
  author: '瑞芝屋',
  authorUid: 356885745,
  text: 'ai确实改变了我的部分生活',
  pubdate: '2026-10-09 13:01',
  likes: 40,
  replies: 0,
};

function fakeDeps(overrides = {}) {
  return {
    port: 9222,
    search: async (query, options) => ({
      ok: true,
      query,
      url: `https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}`,
      loginUid: 1,
      tookMs: 5,
      items: [
        {
          bvid: 'BV1E7wtzaEdq',
          title: '从 LLM 到 Agent Skill',
          author: '马克的技术工作坊',
          authorUid: 1815948385,
          play: '211.3万',
          danmaku: '2894',
          duration: '32:31',
          pubdate: '3月14日',
          url: 'https://www.bilibili.com/video/BV1E7wtzaEdq',
        },
        {
          bvid: 'BV1VZWc6dECG',
          title: '第二条',
          author: 'UP',
          authorUid: null,
          play: '1万',
          danmaku: '1',
          duration: '1:00',
          pubdate: '10月13日',
          url: 'https://www.bilibili.com/video/BV1VZWc6dECG',
        },
      ],
      ...options,
    }),
    read: async (bvid, options) => ({
      ok: true,
      bvid,
      video: sampleVideo,
      comments: [sampleComment],
      commentsTotal: '3278',
      commentsLoaded: 1,
      sort: options?.order === 'new' ? 'time' : 'hot',
      memory: { watched: 'runtime/memory/watched.jsonl', note: 'runtime/memory/notes/2026-10-19.md' },
      tookMs: 5,
    }),
    status: async () => ({
      ok: true,
      port: 9222,
      cdp: true,
      loggedIn: true,
      uid: 3747572864780674,
      memory: { total: 2, file: 'runtime/memory/watched.jsonl', missing: false },
      navigationsLastHour: 1,
      stop: null,
      config: { errors: [], warnings: [] },
    }),
    draft: async ({ bvid, content, note }) => ({
      ok: true,
      draft: {
        id: 'draft-abc123-abcdef',
        status: 'pending',
        target: { bvid: 'BV1E7wtzaEdq' },
        content: `@Kylume ${content}`,
        meta: { note: note ?? '' },
      },
      rule: { verdict: 'pass', risk: 'low', reasons: [] },
      ai: { verdict: 'human', risk: 'medium', reasons: ['AI dry-run'] },
      requiresHuman: true,
    }),
    watched: async () => ({
      total: 2,
      file: 'runtime/memory/watched.jsonl',
      missing: false,
      entries: [
        {
          ts: '2026-10-19T01:00:00.000Z',
          bvid: 'BV1E7wtzaEdq',
          title: '从 LLM 到 Agent Skill',
          author: '马克的技术工作坊',
          commentsRead: 20,
          note: '',
          url: 'https://www.bilibili.com/video/BV1E7wtzaEdq',
        },
      ],
    }),
    ...overrides,
  };
}

function toolByName(tools, name) {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

test('read-only tools expose raw schemas and render text', async () => {
  const tools = createBiliTools(fakeDeps());
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['bili_status', 'bili_search', 'bili_read_video', 'bili_draft_comment', 'bili_watched'],
  );
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(typeof tool.execute, 'function');
  }

  const search = toolByName(tools, 'bili_search');
  const searchValue = await search.execute({ query: 'AI', limit: 2 });
  assert.equal(searchValue.query, 'AI');
  assert.equal(searchValue.items.length, 2);
  const rendered = search.output.render({}, searchValue);
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /BV1E7wtzaEdq/);

  const read = toolByName(tools, 'bili_read_video');
  const readValue = await read.execute({ bvid: 'BV1E7wtzaEdq', comments: 20, order: 'new' });
  assert.equal(readValue.bvid, 'BV1E7wtzaEdq');
  assert.equal(readValue.video.title, sampleVideo.title);
  assert.equal(readValue.comments[0].text, sampleComment.text);
  assert.equal(readValue.sort, 'time');
  assert.match(read.output.render({}, readValue)[0].text, /3278/);

  const draft = toolByName(tools, 'bili_draft_comment');
  const draftValue = await draft.execute({ bvid: 'BV1E7wtzaEdq', content: '讲得清楚', note: '测试' });
  assert.equal(draftValue.draftId, 'draft-abc123-abcdef');
  assert.equal(draftValue.status, 'pending');
  assert.equal(draftValue.content, '@Kylume 讲得清楚');
  assert.equal(draftValue.requiresHuman, true);
  assert.match(draft.output.render({}, draftValue)[0].text, /人工批准/);

  const statusValue = await toolByName(tools, 'bili_status').execute({});
  assert.equal(statusValue.loggedIn, true);
  assert.equal(statusValue.memory.total, 2);
  assert.match(toolByName(tools, 'bili_status').output.render({}, statusValue)[0].text, /UID/);

  const watchedValue = await toolByName(tools, 'bili_watched').execute({ limit: 10 });
  assert.equal(watchedValue.total, 2);
  assert.equal(watchedValue.entries[0].bvid, 'BV1E7wtzaEdq');
  assert.match(toolByName(tools, 'bili_watched').output.render({}, watchedValue)[0].text, /看过 2 个视频/);
});

test('tool errors are converted to thrown errors', async () => {
  const tools = createBiliTools(fakeDeps({ search: async () => ({ ok: false, errors: ['未登录'] }) }));
  await assert.rejects(() => toolByName(tools, 'bili_search').execute({ query: 'AI' }), /未登录/);
});

test('registerBiliTools registers every tool on the host context', () => {
  const registered = [];
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition);
      },
    },
  };
  const names = registerBiliTools(ctx, fakeDeps());
  assert.deepEqual(names, ['bili_status', 'bili_search', 'bili_read_video', 'bili_draft_comment', 'bili_watched']);
  assert.deepEqual(
    registered.map((tool) => tool.name),
    names,
  );
  assert.throws(() => registerBiliTools({}), /tools 服务不可用/);
});
