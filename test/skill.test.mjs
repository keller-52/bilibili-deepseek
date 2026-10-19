import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '../src/yaml.mjs';

const file = new URL('../.dsh/skills/bili-playbook/SKILL.md', import.meta.url);

test('bili-playbook skill has the required frontmatter', async () => {
  const text = await readFile(file, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  assert.ok(match, 'missing YAML frontmatter');
  const { data } = parse(match[1]);
  assert.equal(data.name, 'bili-playbook');
  assert.match(data.description, /只读/);
  assert.match(data.whenToUse, /B 站/);
  assert.match(text, /bili_status/);
  assert.match(text, /bili_read_video/);
  assert.match(text, /不要.*点赞/);
});
