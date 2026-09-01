import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assignNextTask, completeTaskAndAssignNext, createBatch, loadBatch, resetWebPreparation, transitionTask, recoverBatch, recordArchive, registerWebConversation, retryWebMonitorTask, markWebReadyToSend, markWebManuallySent } from '../src/manifest.js';

test('creates a versioned batch with queued tasks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await createBatch(root, [{ task_id: '001', prompt: 'cover' }]);
  const saved = JSON.parse(await readFile(join(batch.path, 'manifest.json'), 'utf8'));
  assert.equal(saved.schema_version, 1);
  assert.equal(saved.tasks[0].status, 'queued');
  assert.match(batch.path, /图片批次_/);
  assert.equal(batch.batchPath, batch.path);
  assert.equal(batch.extensionLoadPath, batch.path);
  assert.equal(batch.archivePath, join(batch.path, '图片'));
  assert.equal(batch.taskCount, 1);
});

test('records the initial 3:2 channel allocation for a five-image batch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await createBatch(root, ['001', '002', '003', '004', '005'].map((task_id) => ({ task_id })));
  assert.deepEqual((await loadBatch(batch.path)).tasks.map((task) => task.assigned_channel), ['codex', 'web', 'codex', 'web', 'codex']);
});

test('stores the effective single-image prompt for web tasks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await createBatch(root, ['001', '002', '003', '004'].map((task_id) => ({ task_id, variable_prompt: `prompt-${task_id}` })));
  const saved = await loadBatch(batch.path);
  assert.equal(saved.tasks[0].effective_prompt, undefined);
  assert.match(saved.tasks[1].effective_prompt, /prompt-002/);
  assert.match(saved.tasks[1].effective_prompt, /仅生成 1 张图片/);
});

test('assigns the next waiting task to the channel that released capacity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await createBatch(root, Array.from({ length: 11 }, (_, index) => ({ task_id: String(index + 1).padStart(3, '0') })));
  const next = await assignNextTask(batch.path, 'web');
  assert.equal(next.task_id, '011');
  assert.equal(next.assigned_channel, 'web');
});

test('completion releases the same channel to the oldest overflow task atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await createBatch(root, Array.from({ length: 11 }, (_, index) => ({ task_id: String(index + 1), variable_prompt: `prompt-${index + 1}` })));
  await transitionTask(batch.path, '2', 'dispatching');
  await transitionTask(batch.path, '2', 'generating');
  const result = await completeTaskAndAssignNext(batch.path, '2', 'web', { conversation_url: 'https://chatgpt.com/g/project/c/two' });
  assert.equal(result.completedTask.status, 'completed');
  assert.equal(result.nextTask.task_id, '11');
  assert.equal(result.nextTask.assigned_channel, 'web');
  assert.match(result.nextTask.effective_prompt, /仅生成 1 张图片/);
  const saved = await loadBatch(batch.path);
  assert.equal(saved.tasks.find((task) => task.task_id === '2').status, 'completed');
});

test('rejects duplicate task ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  await assert.rejects(() => createBatch(root, [{ task_id: '001' }, { task_id: '001' }]));
});

test('records a valid task transition in manifest and event log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await createBatch(root, [{ task_id: '001' }]);
  await transitionTask(batch.path, '001', 'dispatching');
  const saved = JSON.parse(await readFile(join(batch.path, 'manifest.json'), 'utf8'));
  const events = await readFile(join(batch.path, 'events.jsonl'), 'utf8');
  assert.equal(saved.tasks[0].status, 'dispatching');
  assert.match(events, /"to":"dispatching"/);
});

test('records a blocking reason at the state-transition boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await createBatch(root, [{ task_id: '001' }]);
  await transitionTask(batch.path, '001', 'dispatching');
  await transitionTask(batch.path, '001', 'blocked', { reason: 'send_button_unavailable' });
  const events = await readFile(join(batch.path, 'events.jsonl'), 'utf8');
  assert.match(events, /"reason":"send_button_unavailable"/);
});

test('hydrates a legacy blocked monitor reason from the event log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await createBatch(root, ['001', '002', '003', '004'].map((task_id) => ({ task_id })));
  await registerWebConversation(batch.path, '002', 'https://chatgpt.com/g/project/c/two');
  await transitionTask(batch.path, '002', 'ready_to_send');
  await transitionTask(batch.path, '002', 'generating');
  await transitionTask(batch.path, '002', 'blocked', { reason: 'ambiguous_result', count: 2 });
  const saved = JSON.parse(await readFile(join(batch.path, 'manifest.json'), 'utf8'));
  delete saved.tasks.find((task) => task.task_id === '002').last_error;
  await writeFile(join(batch.path, 'manifest.json'), `${JSON.stringify(saved, null, 2)}\n`);
  const loaded = await loadBatch(batch.path);
  assert.deepEqual(loaded.tasks.find((task) => task.task_id === '002').last_error, { reason: 'ambiguous_result', count: 2 });
});

test('rearms a blocked web monitor task without resending the prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await createBatch(root, ['001', '002', '003', '004'].map((task_id) => ({ task_id })));
  await registerWebConversation(batch.path, '002', 'https://chatgpt.com/g/project/c/two');
  await transitionTask(batch.path, '002', 'ready_to_send');
  await transitionTask(batch.path, '002', 'generating');
  await transitionTask(batch.path, '002', 'blocked', { reason: 'ambiguous_result', count: 2 });
  const retried = await retryWebMonitorTask(batch.path, '002');
  assert.equal(retried.status, 'generating');
  assert.equal(retried.monitor_retry_count, 1);
  assert.equal(retried.last_error, undefined);
  assert.equal((await loadBatch(batch.path)).tasks.find((task) => task.task_id === '002').status, 'generating');
  assert.equal((await loadBatch(batch.path)).tasks.find((task) => task.task_id === '002').last_error, undefined);
});

test('preserves concurrent transitions for independent tasks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await createBatch(root, [{ task_id: '001' }, { task_id: '002' }]);
  await Promise.all([
    transitionTask(batch.path, '001', 'dispatching'),
    transitionTask(batch.path, '002', 'dispatching'),
  ]);
  assert.deepEqual((await loadBatch(batch.path)).tasks.map((task) => task.status), ['dispatching', 'dispatching']);
});

test('loads a saved batch for recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await createBatch(root, [{ task_id: '001' }]);
  assert.equal((await loadBatch(batch.path)).batch_id, batch.batch_id);
});

test('only resumes never-started or explicitly retryable tasks and blocks interrupted work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await createBatch(root, [{ task_id: 'queued' }, { task_id: 'started' }, { task_id: 'retry' }]);
  await transitionTask(batch.path, 'started', 'dispatching');
  await transitionTask(batch.path, 'retry', 'dispatching');
  await transitionTask(batch.path, 'retry', 'retryable_failure');
  const result = await recoverBatch(batch.path);
  assert.deepEqual(result.resumable_task_ids.sort(), ['queued', 'retry']);
  assert.deepEqual(result.blocked_task_ids, ['started']);
  assert.equal((await loadBatch(batch.path)).tasks.find((task) => task.task_id === 'started').status, 'blocked');
});

test('records an archived artifact and increments its version without overwriting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await createBatch(root, [{ task_id: '001' }]);
  await transitionTask(batch.path, '001', 'dispatching');
  await transitionTask(batch.path, '001', 'generating');
  await transitionTask(batch.path, '001', 'completed');
  const artifact = await recordArchive(batch.path, '001', { channel: 'web', path: '/tmp/001_web_cover_v01.png' });
  assert.equal(artifact.version, 1);
  const saved = await loadBatch(batch.path);
  assert.equal(saved.tasks[0].status, 'archived');
  assert.equal(saved.tasks[0].artifacts[0].path, '/tmp/001_web_cover_v01.png');
});

test('resets only unstarted web preparation state and preserves active or archived work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await createBatch(root, [
    { task_id: '001', prompt: 'codex task' },
    { task_id: '002', variable_prompt: 'web draft to reset' },
    { task_id: '003', prompt: 'codex task 2' },
    { task_id: '004', variable_prompt: 'web queued with stale url' },
    { task_id: '005', prompt: 'codex task 3' },
    { task_id: '006', variable_prompt: 'web active task' },
    { task_id: '007', prompt: 'codex task 4' },
    { task_id: '008', variable_prompt: 'web monitor task' },
  ]);
  await registerWebConversation(batch.path, '002', 'https://chatgpt.com/g/project/c/two');
  await markWebReadyToSend(batch.path, '002');
  await registerWebConversation(batch.path, '004', 'https://chatgpt.com/g/project/c/four');
  await registerWebConversation(batch.path, '006', 'https://chatgpt.com/g/project/c/six');
  await markWebReadyToSend(batch.path, '006');
  await markWebManuallySent(batch.path, '006', { confirmed: true });
  await transitionTask(batch.path, '006', 'completed');
  await recordArchive(batch.path, '006', { channel: 'web', path: '/tmp/006.png' });
  await registerWebConversation(batch.path, '008', 'https://chatgpt.com/g/project/c/eight');
  await markWebReadyToSend(batch.path, '008');
  await markWebManuallySent(batch.path, '008', { confirmed: true });
  await transitionTask(batch.path, '008', 'blocked', { reason: 'download_unavailable' });

  const result = await resetWebPreparation(batch.path);

  assert.deepEqual(result.reset_task_ids, ['002', '004']);
  const saved = await loadBatch(batch.path);
  const task002 = saved.tasks.find((task) => task.task_id === '002');
  const task004 = saved.tasks.find((task) => task.task_id === '004');
  const task006 = saved.tasks.find((task) => task.task_id === '006');
  const task008 = saved.tasks.find((task) => task.task_id === '008');
  assert.equal(task002.status, 'queued');
  assert.equal(task002.web_conversation_url, undefined);
  assert.equal(task002.effective_prompt.includes('web draft to reset'), true);
  assert.equal(task004.status, 'queued');
  assert.equal(task004.web_conversation_url, undefined);
  assert.equal(task006.status, 'archived');
  assert.equal(task006.web_conversation_url, 'https://chatgpt.com/g/project/c/six');
  assert.equal(task008.status, 'blocked');
  assert.equal(task008.web_conversation_url, 'https://chatgpt.com/g/project/c/eight');
  assert.match(await readFile(join(batch.path, 'events.jsonl'), 'utf8'), /"type":"web_preparation_reset"/);
});
