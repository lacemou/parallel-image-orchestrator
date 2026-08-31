import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCommand } from '../bridge/stdin.js';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('returns a successful one-shot health check without browser evidence', async () => {
  assert.deepEqual(await handleCommand({ type: 'health_check' }), { ok: true, status: 'ready' });
});

test('blocks a preflight without browser evidence', async () => {
  assert.deepEqual(await handleCommand({ type: 'preflight' }), { ok: false, status: 'blocked', reason: 'browser_preflight_missing' });
});

test('rejects external mutation commands in the first milestone', async () => {
  await assert.rejects(() => handleCommand({ type: 'send' }), /unsupported command/);
  await assert.rejects(() => handleCommand({ type: 'upload' }), /unsupported command/);
});

test('creates only a local batch for an allowed create_batch command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const result = await handleCommand({ type: 'create_batch', root, tasks: [{ task_id: '001' }] });
  assert.equal(result.ok, true);
  assert.match(result.path, /图片批次_/);
});

test('creates a batch from a user-selected Markdown prompt directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const promptDir = join(root, 'prompts');
  const outputRoot = join(root, 'output');
  await mkdir(promptDir);
  await mkdir(outputRoot);
  await writeFile(join(promptDir, '001.md'), '封面提示词');
  await writeFile(join(promptDir, '002.md'), '正文提示词');
  await writeFile(join(promptDir, '003.md'), '卡片提示词');
  await writeFile(join(promptDir, '004.md'), '补充提示词');

  const result = await handleCommand({ type: 'create_batch_from_prompt_dir', root: outputRoot, promptDir });

  assert.equal(result.ok, true);
  assert.match(result.path, /图片批次_/);
  const manifest = JSON.parse(await readFile(join(result.path, 'manifest.json'), 'utf8'));
  assert.equal(manifest.tasks[1].variable_prompt, '正文提示词');
  assert.match(manifest.tasks[1].effective_prompt, /仅生成 1 张图片/);
  assert.equal(manifest.tasks[1].prompt_source.path, join(promptDir, '002.md'));
});

test('returns an actionable reason when a batch path has no manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const result = await handleCommand({ type: 'load_batch', batchPath: join(root, 'prompts') });
  assert.deepEqual(result, { ok: false, status: 'blocked', reason: 'batch_manifest_missing' });
});

test('archives a completed download through the bridge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await handleCommand({ type: 'create_batch', root, tasks: [{ task_id: '001', basename: 'cover' }] });
  const source = join(root, 'source.png');
  await writeFile(source, 'image');
  await handleCommand({ type: 'transition_task', batchPath: batch.path, task_id: '001', nextStatus: 'dispatching' });
  await handleCommand({ type: 'transition_task', batchPath: batch.path, task_id: '001', nextStatus: 'generating' });
  await handleCommand({ type: 'transition_task', batchPath: batch.path, task_id: '001', nextStatus: 'completed' });
  const result = await handleCommand({ type: 'archive_download', confirmed: true, batchPath: batch.path, task_id: '001', channel: 'web', sourcePath: source });
  assert.equal(result.ok, true);
});

test('records a manually sent web task only after its unique conversation is registered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await handleCommand({ type: 'create_batch', root, tasks: ['001', '002', '003', '004'].map((task_id) => ({ task_id })) });
  await handleCommand({ type: 'register_web_conversation', batchPath: batch.path, task_id: '002', conversationUrl: 'https://chatgpt.com/g/project/c/two' });
  await handleCommand({ type: 'mark_web_ready_to_send', batchPath: batch.path, task_id: '002' });
  const result = await handleCommand({ type: 'mark_web_manually_sent', batchPath: batch.path, task_id: '002', confirmed: true });
  assert.equal(result.task.status, 'generating');
});

test('completes a web result and returns the next task assigned to the released channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await handleCommand({
    type: 'create_batch',
    root,
    tasks: Array.from({ length: 11 }, (_, index) => ({ task_id: String(index + 1).padStart(3, '0') })),
  });
  await handleCommand({ type: 'transition_task', batchPath: batch.path, task_id: '002', nextStatus: 'dispatching' });
  await handleCommand({ type: 'transition_task', batchPath: batch.path, task_id: '002', nextStatus: 'generating' });

  const result = await handleCommand({
    type: 'complete_web_result',
    batchPath: batch.path,
    task_id: '002',
    confirmed: true,
    details: { conversation_url: 'https://chatgpt.com/g/project/c/two' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.completedTask.status, 'completed');
  assert.equal(result.nextTask.task_id, '011');
  assert.equal(result.nextTask.assigned_channel, 'web');
});

test('completes and archives a Codex result while releasing the Codex slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await handleCommand({
    type: 'create_batch',
    root,
    tasks: Array.from({ length: 11 }, (_, index) => ({ task_id: String(index + 1).padStart(3, '0'), basename: `image_${index + 1}` })),
  });
  const source = join(root, 'codex-result.png');
  await writeFile(source, 'image');
  await handleCommand({ type: 'transition_task', batchPath: batch.path, task_id: '001', nextStatus: 'dispatching' });
  await handleCommand({ type: 'transition_task', batchPath: batch.path, task_id: '001', nextStatus: 'generating' });

  const result = await handleCommand({
    type: 'archive_codex_image',
    confirmed: true,
    batchPath: batch.path,
    task_id: '001',
    channel: 'codex',
    sourcePath: source,
  });

  assert.equal(result.ok, true);
  assert.equal(result.completedTask.status, 'completed');
  assert.equal(result.nextTask.task_id, '011');
  assert.equal(result.nextTask.assigned_channel, 'codex');
  assert.equal((await handleCommand({ type: 'load_batch', batchPath: batch.path })).manifest.tasks.find((task) => task.task_id === '001').status, 'archived');
});

test('rearms a blocked web monitor task through the confirmed bridge command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await handleCommand({ type: 'create_batch', root, tasks: ['001', '002', '003', '004'].map((task_id) => ({ task_id })) });
  await handleCommand({ type: 'register_web_conversation', batchPath: batch.path, task_id: '002', conversationUrl: 'https://chatgpt.com/g/project/c/two' });
  await handleCommand({ type: 'mark_web_ready_to_send', batchPath: batch.path, task_id: '002' });
  await handleCommand({ type: 'mark_web_manually_sent', batchPath: batch.path, task_id: '002', confirmed: true });
  await handleCommand({ type: 'transition_task', batchPath: batch.path, task_id: '002', nextStatus: 'blocked', details: { reason: 'ambiguous_result' } });
  const result = await handleCommand({ type: 'retry_web_monitor', batchPath: batch.path, task_id: '002', confirmed: true });
  assert.equal(result.ok, true);
  assert.equal(result.task.status, 'generating');
});

test('does not archive a download unless the batch is confirmed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const result = await handleCommand({ type: 'archive_download', batchPath: root, task_id: '001', channel: 'web', sourcePath: join(root, 'image.png') });
  assert.equal(result.reason, 'batch_not_confirmed');
});

test('requires explicit confirmation before resetting web preparation state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await handleCommand({
    type: 'create_batch',
    root,
    tasks: ['001', '002', '003', '004'].map((task_id) => ({ task_id })),
  });
  const blocked = await handleCommand({ type: 'reset_web_preparation', batchPath: batch.path });
  assert.deepEqual(blocked, { ok: false, status: 'blocked', reason: 'batch_not_confirmed' });
  const reset = await handleCommand({ type: 'reset_web_preparation', batchPath: batch.path, confirmed: true });
  assert.deepEqual(reset, { ok: true, batch_id: batch.batch_id, reset_task_ids: ['002', '004'] });
});
