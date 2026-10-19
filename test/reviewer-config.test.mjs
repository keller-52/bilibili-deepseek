import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  deleteReviewerConfig,
  loadReviewerConfig,
  resolveReviewerTransport,
  reviewerStatus,
  saveReviewerConfig,
} from '../src/reviewer-config.mjs';

async function tempFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bili-reviewer-'));
  return { dir, file: path.join(dir, 'reviewer.local.json') };
}

test('saving reviewer config writes the key locally but never returns it', async () => {
  const { dir, file } = await tempFile();
  try {
    const saved = await saveReviewerConfig(
      { endpoint: 'https://api.example.com/chat/completions', model: 'review-model', apiKey: 'sk-test-123' },
      { file },
    );
    assert.equal(saved.ok, true);
    assert.equal(saved.status.mode, 'http');
    assert.equal(saved.status.hasKey, true);
    assert.equal(saved.status.apiKey, undefined);

    const raw = await readFile(file, 'utf8');
    assert.match(raw, /sk-test-123/);
    const status = await reviewerStatus({ file });
    assert.equal(status.endpointHost, 'api.example.com');
    assert.equal(status.model, 'review-model');
    assert.equal(status.apiKey, undefined);

    const loaded = await loadReviewerConfig({ file });
    assert.equal(loaded.apiKey, 'sk-test-123');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('saving with an empty key preserves the existing key', async () => {
  const { dir, file } = await tempFile();
  try {
    await saveReviewerConfig({ endpoint: 'https://api.example.com/chat', apiKey: 'sk-keep' }, { file });
    const saved = await saveReviewerConfig({ endpoint: 'https://api.example.com/chat', model: 'm2', apiKey: '' }, { file });
    assert.equal(saved.ok, true);
    assert.equal(saved.replacedKey, true);
    assert.equal(saved.status.hasKey, true);
    const loaded = await loadReviewerConfig({ file });
    assert.equal(loaded.apiKey, 'sk-keep');
    assert.equal(loaded.model, 'm2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid URLs are rejected', async () => {
  const { dir, file } = await tempFile();
  try {
    const saved = await saveReviewerConfig({ endpoint: 'ftp://example.com/chat' }, { file });
    assert.equal(saved.ok, false);
    assert.match(saved.errors[0], /http/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('environment variables are a fallback when no local file exists', async () => {
  const { dir, file } = await tempFile();
  try {
    const status = await reviewerStatus({
      file,
      env: { BILI_REVIEW_API_URL: 'https://env.example/chat', BILI_REVIEW_API_KEY: 'sk-env', BILI_REVIEW_MODEL: 'env-model' },
    });
    assert.equal(status.mode, 'http');
    assert.equal(status.source, 'env');
    assert.equal(status.model, 'env-model');
    assert.equal(status.hasKey, true);
    assert.equal(status.apiKey, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a local file takes precedence over environment variables', async () => {
  const { dir, file } = await tempFile();
  try {
    await saveReviewerConfig({ endpoint: 'https://file.example/chat', model: 'file-model', apiKey: 'sk-file' }, { file });
    const status = await reviewerStatus({
      file,
      env: { BILI_REVIEW_API_URL: 'https://env.example/chat', BILI_REVIEW_API_KEY: 'sk-env' },
    });
    assert.equal(status.source, 'file');
    assert.equal(status.endpointHost, 'file.example');
    assert.equal(status.hasKey, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('clearing the file falls back to environment or dry-run', async () => {
  const { dir, file } = await tempFile();
  try {
    await saveReviewerConfig({ endpoint: 'https://api.example.com/chat', apiKey: 'sk-1' }, { file });
    const cleared = await deleteReviewerConfig({ file });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.status.mode, 'dry-run');
    const transport = await resolveReviewerTransport({ file, env: {} });
    assert.equal(transport, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolving a transport returns a callable function for an enabled config', async () => {
  const { dir, file } = await tempFile();
  try {
    await saveReviewerConfig({ endpoint: 'https://api.example.com/chat', apiKey: 'sk-1' }, { file });
    const transport = await resolveReviewerTransport({ file, env: {} });
    assert.equal(typeof transport, 'function');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
