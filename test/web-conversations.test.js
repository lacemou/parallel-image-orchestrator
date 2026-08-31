import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBatch, loadBatch, markWebManuallySent, markWebReadyToSend, registerWebConversation } from '../src/manifest.js';
import { assertUniqueProjectConversations, normalizeProjectConversation } from '../src/web-conversations.js';

test('normalizes a unique Project conversation URL', () => {
  assert.equal(normalizeProjectConversation('https://chatgpt.com/g/project/c/one/'), 'https://chatgpt.com/g/project/c/one');
});

test('manual web send requires a unique ready conversation and confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-web-'));
  const batch = await createBatch(root, ['001', '002', '003', '004'].map((task_id) => ({ task_id })));
  await assert.rejects(() => markWebManuallySent(batch.path, '002', { confirmed: true }), /web_task_not_ready_to_send/);
  await registerWebConversation(batch.path, '002', 'https://chatgpt.com/g/project/c/two');
  await markWebReadyToSend(batch.path, '002');
  await assert.rejects(() => markWebManuallySent(batch.path, '002', { confirmed: false }), /batch_not_confirmed/);
  assert.equal((await markWebManuallySent(batch.path, '002', { confirmed: true })).status, 'generating');
});

test('rejects a Project home URL', () => {
  assert.throws(() => normalizeProjectConversation('https://chatgpt.com/g/project/project'), /conversation_url_invalid/);
});

test('rejects duplicate or pre-conversation URLs before any prompt is filled', () => {
  assert.throws(() => assertUniqueProjectConversations([
    'https://chatgpt.com/g/project/c/one',
    'https://chatgpt.com/g/project/c/one',
  ]), /conversation_urls_not_unique/);
  assert.deepEqual(assertUniqueProjectConversations([
    'https://chatgpt.com/g/project/c/one',
    'https://chatgpt.com/g/project/c/two',
  ]), ['https://chatgpt.com/g/project/c/one', 'https://chatgpt.com/g/project/c/two']);
});

test('registers a unique conversation URL for a queued web task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-web-'));
  const batch = await createBatch(root, ['001', '002', '003', '004'].map((task_id) => ({ task_id })));
  const url = 'https://chatgpt.com/g/project/c/one';
  await registerWebConversation(batch.path, '002', url);
  assert.equal((await loadBatch(batch.path)).tasks.find((task) => task.task_id === '002').web_conversation_url, url);
  await assert.rejects(() => registerWebConversation(batch.path, '004', url), /conversation_url_already_registered/);
});
