import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initialAssignments } from './scheduler.js';
import { normalizeProjectConversation } from './web-conversations.js';
import { ensureSingleImagePrompt } from './web-monitor.js';

export async function createBatch(root, tasks) {
  const ids = tasks.map((task) => task.task_id);
  if (ids.some((id, index) => !id || ids.indexOf(id) !== index)) throw new Error('task_id must be unique');
  const batch_id = randomUUID();
  const path = join(root, `图片批次_${batch_id}`);
  await mkdir(path, { recursive: false });
  await mkdir(join(path, '图片'));
  const assignments = tasks.length >= 4 ? new Map(initialAssignments(tasks.map((task) => task.task_id)).map((item) => [item.task_id, item.channel])) : new Map();
  const manifest = {
    schema_version: 1,
    batch_id,
    tasks: tasks.map((task) => {
      const assigned_channel = assignments.get(task.task_id) ?? null;
      return {
        ...task,
        ...(assigned_channel === 'web' ? { effective_prompt: ensureSingleImagePrompt(task.variable_prompt ?? task.prompt ?? '') } : {}),
        assigned_channel,
        status: 'queued',
      };
    }),
  };
  await writeFile(join(path, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(path, 'events.jsonl'), '');
  return { path, ...manifest };
}

export async function loadBatch(batchPath) {
  const manifest = JSON.parse(await readFile(join(batchPath, 'manifest.json'), 'utf8'));
  try {
    const events = (await readFile(join(batchPath, 'events.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const lastByTask = new Map();
    for (const event of events) if (event?.task_id) lastByTask.set(event.task_id, event);
    for (const task of manifest.tasks ?? []) {
      const last = lastByTask.get(task.task_id);
      if (task.status === 'blocked' && last?.to === 'blocked' && last.reason && !task.last_error) {
        task.last_error = { reason: last.reason, ...(Number.isFinite(last.count) ? { count: last.count } : {}) };
      }
    }
  } catch {
    // A legacy or partially written event log must not prevent the batch from loading.
  }
  return manifest;
}

export async function withBatchLock(batchPath, operation) {
  const lockPath = join(batchPath, '.manifest.lock');
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) throw new Error('manifest_lock_timeout');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try { return await operation(); }
  finally { await rm(lockPath, { recursive: true, force: true }); }
}

const transitions = { queued: ['dispatching', 'ready_to_send', 'blocked', 'failed'], ready_to_send: ['generating', 'blocked'], dispatching: ['generating', 'retryable_failure', 'blocked'], generating: ['completed', 'retryable_failure', 'blocked', 'failed'], completed: ['archived', 'blocked'] };

async function writeManifestAndEvent(batchPath, manifest, event) {
  await writeFile(join(batchPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await appendFile(join(batchPath, 'events.jsonl'), `${JSON.stringify(event)}\n`);
}

export async function transitionTask(batchPath, taskId, nextStatus, details = {}) {
  return withBatchLock(batchPath, async () => {
    const manifest = await loadBatch(batchPath);
    const task = manifest.tasks.find((item) => item.task_id === taskId);
    if (!task || !transitions[task.status]?.includes(nextStatus)) throw new Error('invalid task transition');
    const from = task.status;
    task.status = nextStatus;
    if (nextStatus === 'blocked' && details && typeof details === 'object') {
      task.last_error = { ...details };
    }
    await writeManifestAndEvent(batchPath, manifest, { task_id: taskId, from, to: nextStatus, ...details });
    return task;
  });
}

export async function retryWebMonitorTask(batchPath, taskId) {
  return withBatchLock(batchPath, async () => {
    const manifest = await loadBatch(batchPath);
    const task = manifest.tasks.find((item) => item.task_id === taskId);
    if (!task || task.assigned_channel !== 'web' || task.status !== 'blocked' || !task.web_conversation_url) {
      throw new Error('web_monitor_retry_requires_blocked_web_task');
    }
    const from = task.status;
    task.status = 'generating';
    delete task.last_error;
    task.monitor_retry_count = Number(task.monitor_retry_count ?? 0) + 1;
    await writeManifestAndEvent(batchPath, manifest, {
      task_id: taskId,
      from,
      to: 'generating',
      reason: 'web_monitor_retry',
      retry_count: task.monitor_retry_count,
    });
    return task;
  });
}

export async function assignNextTask(batchPath, channel) {
  if (!['codex', 'web'].includes(channel)) throw new Error('invalid_channel');
  return withBatchLock(batchPath, async () => {
    const manifest = await loadBatch(batchPath);
    const task = manifest.tasks.find((item) => item.status === 'queued' && item.assigned_channel === 'queued');
    if (!task) return null;
    const from = task.assigned_channel;
    task.assigned_channel = channel;
    if (channel === 'web' && !task.effective_prompt) task.effective_prompt = ensureSingleImagePrompt(task.variable_prompt ?? task.prompt ?? '');
    await writeManifestAndEvent(batchPath, manifest, { task_id: task.task_id, assignment_from: from, assignment_to: channel, reason: 'channel_slot_released' });
    return task;
  });
}

export async function completeTaskAndAssignNext(batchPath, taskId, channel, details = {}) {
  if (!['codex', 'web'].includes(channel)) throw new Error('invalid_channel');
  return withBatchLock(batchPath, async () => {
    const manifest = await loadBatch(batchPath);
    const completedTask = manifest.tasks.find((task) => task.task_id === taskId);
    if (!completedTask || completedTask.status !== 'generating' || completedTask.assigned_channel !== channel) throw new Error('completion_requires_generating_channel_task');
    const from = completedTask.status;
    completedTask.status = 'completed';
    const nextTask = manifest.tasks.find((task) => task.status === 'queued' && task.assigned_channel === 'queued') ?? null;
    const events = [{ task_id: taskId, from, to: 'completed', ...details }];
    if (nextTask) {
      const assignmentFrom = nextTask.assigned_channel;
      nextTask.assigned_channel = channel;
      if (channel === 'web' && !nextTask.effective_prompt) nextTask.effective_prompt = ensureSingleImagePrompt(nextTask.variable_prompt ?? nextTask.prompt ?? '');
      events.push({ task_id: nextTask.task_id, assignment_from: assignmentFrom, assignment_to: channel, reason: 'channel_slot_released' });
    }
    await writeFile(join(batchPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await appendFile(join(batchPath, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    return { completedTask, nextTask };
  });
}

export async function registerWebConversation(batchPath, taskId, conversationUrl) {
  const normalized = normalizeProjectConversation(conversationUrl);
  return withBatchLock(batchPath, async () => {
    const manifest = await loadBatch(batchPath);
    const task = manifest.tasks.find((item) => item.task_id === taskId);
    if (!task || task.assigned_channel !== 'web' || task.status !== 'queued') throw new Error('web_conversation_requires_queued_web_task');
    if (manifest.tasks.some((item) => item.task_id !== taskId && item.web_conversation_url === normalized)) throw new Error('conversation_url_already_registered');
    task.web_conversation_url = normalized;
    await writeManifestAndEvent(batchPath, manifest, { task_id: taskId, type: 'web_conversation_registered', web_conversation_url: normalized });
    return task;
  });
}

export async function markWebReadyToSend(batchPath, taskId) {
  return withBatchLock(batchPath, async () => {
    const manifest = await loadBatch(batchPath);
    const task = manifest.tasks.find((item) => item.task_id === taskId);
    if (!task?.web_conversation_url || task.assigned_channel !== 'web' || task.status !== 'queued') throw new Error('web_conversation_missing');
    task.status = 'ready_to_send';
    await writeManifestAndEvent(batchPath, manifest, { task_id: taskId, from: 'queued', to: 'ready_to_send', web_conversation_url: task.web_conversation_url });
    return task;
  });
}

export async function markWebManuallySent(batchPath, taskId, { confirmed } = {}) {
  if (!confirmed) throw new Error('batch_not_confirmed');
  return withBatchLock(batchPath, async () => {
    const manifest = await loadBatch(batchPath);
    const task = manifest.tasks.find((item) => item.task_id === taskId);
    if (!task?.web_conversation_url || task.status !== 'ready_to_send') throw new Error('web_task_not_ready_to_send');
    task.status = 'generating';
    await writeManifestAndEvent(batchPath, manifest, { task_id: taskId, from: 'ready_to_send', to: 'generating', reason: 'user_confirmed_manual_send' });
    return task;
  });
}

/**
 * Forget the local preparation state for web tasks that have not been sent.
 *
 * This deliberately does not rewind a generating, completed, archived, or
 * otherwise identified conversation. Resetting those states could cause a
 * second image to be generated or detach an in-flight monitor from its task.
 */
export async function resetWebPreparation(batchPath) {
  return withBatchLock(batchPath, async () => {
    const manifest = await loadBatch(batchPath);
    const reset_task_ids = [];
    const events = [];
    for (const task of manifest.tasks ?? []) {
      if (task.assigned_channel !== 'web' || !['queued', 'ready_to_send'].includes(task.status)) continue;
      const from = task.status;
      task.status = 'queued';
      delete task.web_conversation_url;
      delete task.last_error;
      delete task.monitor_retry_count;
      reset_task_ids.push(task.task_id);
      events.push({
        task_id: task.task_id,
        type: 'web_preparation_reset',
        from,
        to: 'queued',
        reason: 'user_requested_reset',
      });
    }
    if (events.length) {
      await writeFile(join(batchPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      await appendFile(join(batchPath, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    }
    return { batch_id: manifest.batch_id, reset_task_ids };
  });
}

export async function recoverBatch(batchPath) {
  return withBatchLock(batchPath, async () => {
    const manifest = await loadBatch(batchPath);
    const resumable_task_ids = [];
    const blocked_task_ids = [];
    for (const task of manifest.tasks) {
      if (task.status === 'queued' || task.status === 'retryable_failure') resumable_task_ids.push(task.task_id);
      if (task.status === 'dispatching' || task.status === 'generating') {
        const from = task.status;
        task.status = 'blocked';
        blocked_task_ids.push(task.task_id);
        await appendFile(join(batchPath, 'events.jsonl'), `${JSON.stringify({ task_id: task.task_id, from, to: 'blocked', reason: 'interrupted_state_requires_user_review' })}\n`);
      }
    }
    await writeFile(join(batchPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { batch_id: manifest.batch_id, resumable_task_ids, blocked_task_ids };
  });
}

export async function recordArchive(batchPath, taskId, artifact) {
  return withBatchLock(batchPath, async () => {
    const manifest = await loadBatch(batchPath);
    const task = manifest.tasks.find((item) => item.task_id === taskId);
    if (!task || task.status !== 'completed') throw new Error('archive_requires_completed_task');
    const artifacts = task.artifacts ?? [];
    const version = artifact.version ?? artifacts.length + 1;
    const from = task.status;
    task.status = 'archived';
    task.artifacts = [...artifacts, { ...artifact, version, archived_at: new Date().toISOString() }];
    await writeManifestAndEvent(batchPath, manifest, { task_id: taskId, from, to: 'archived', artifact: task.artifacts.at(-1) });
    return task.artifacts.at(-1);
  });
}
