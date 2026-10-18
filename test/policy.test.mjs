import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureOwnerMention, extractMentions } from '../src/policy.mjs';

const owner = { uid: 1, name: 'Kylume' };

test('extractMentions finds @names', () => {
  assert.deepEqual(extractMentions('@Kylume 你好，@另一个人 也来'), ['Kylume', '另一个人']);
});

test('adds the owner mention when missing', () => {
  const result = ensureOwnerMention('这个视频讲得不错', owner);
  assert.equal(result.ok, true);
  assert.equal(result.added, true);
  assert.equal(result.text, '@Kylume 这个视频讲得不错');
});

test('keeps an existing owner mention', () => {
  const result = ensureOwnerMention('@Kylume 这个视频讲得不错', owner);
  assert.equal(result.ok, true);
  assert.equal(result.added, false);
});

test('rejects mentioning anyone else', () => {
  const result = ensureOwnerMention('@Kylume @路人甲 你们看', owner);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /不能 @ 其他人/);
});

test('rejects when no owner is marked', () => {
  const result = ensureOwnerMention('随便说说', null);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /主人/);
});
