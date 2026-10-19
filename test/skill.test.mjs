import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '../src/yaml.mjs';

function skillUrl(name) {
  return new URL(`../.dsh/skills/${name}/SKILL.md`, import.meta.url);
}

async function frontmatter(name) {
  const text = await readFile(skillUrl(name), 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  assert.ok(match, `${name}: missing YAML frontmatter`);
  return { text, data: parse(match[1]).data };
}

test('bili-playbook skill has the required frontmatter', async () => {
  const { text, data } = await frontmatter('bili-playbook');
  assert.equal(data.name, 'bili-playbook');
  assert.match(data.description, /只读/);
  assert.match(data.whenToUse, /B 站/);
  assert.match(text, /bili_status/);
  assert.match(text, /bili_read_video/);
  assert.match(text, /不要.*点赞/);
});

test('bili-comment skill is draft-only and forbids publishing', async () => {
  const { text, data } = await frontmatter('bili-comment');
  assert.equal(data.name, 'bili-comment');
  assert.match(data.description, /草稿/);
  assert.match(text, /bili_draft_comment/);
  assert.match(text, /不能批准/);
  assert.match(text, /没有.*批准\/发布工具|没有.*批准/);
  assert.match(text, /不要调用任何 `\/approve`/);
});
