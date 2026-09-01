import { assignNextTask, completeTaskAndAssignNext, createBatch, loadBatch, markWebManuallySent, markWebReadyToSend, recoverBatch, registerWebConversation, resetWebPreparation, retryWebMonitorTask, transitionTask } from '../src/manifest.js';
import { archiveDownload } from '../src/archive.js';
import { createBatchFromPromptDirectory } from '../src/prompt-files.js';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

function createdBatchResult(batch) {
  const batchPath = batch.path;
  return {
    ok: true,
    path: batchPath,
    batchPath,
    extensionLoadPath: batchPath,
    archivePath: join(batchPath, '图片'),
    batch_id: batch.batch_id,
    taskCount: batch.tasks.length,
  };
}

export async function handleCommand(command) {
  if (command?.type === 'health_check') return { ok: true, status: 'ready' };
  if (command?.type === 'preflight') return { ok: false, status: 'blocked', reason: 'browser_preflight_missing' };
  if (command?.type === 'create_batch') {
    if (!command.root || !Array.isArray(command.tasks)) return { ok: false, status: 'blocked', reason: 'batch_input_missing' };
    const batch = await createBatch(command.root, command.tasks);
    return createdBatchResult(batch);
  }
  if (command?.type === 'create_batch_from_prompt_dir') {
    if (!command.root || !command.promptDir) return { ok: false, status: 'blocked', reason: 'prompt_batch_input_missing' };
    const batch = await createBatchFromPromptDirectory(command.root, command.promptDir);
    return createdBatchResult(batch);
  }
  if (command?.type === 'load_batch') {
    if (!command.batchPath) return { ok: false, status: 'blocked', reason: 'batch_path_missing' };
    try {
      return { ok: true, manifest: await loadBatch(command.batchPath) };
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { ok: false, status: 'blocked', reason: 'batch_manifest_missing' };
      if (error instanceof SyntaxError) return { ok: false, status: 'blocked', reason: 'batch_manifest_invalid' };
      throw error;
    }
  }
  if (command?.type === 'recover_batch') {
    if (!command.batchPath) return { ok: false, status: 'blocked', reason: 'batch_path_missing' };
    return { ok: true, ...(await recoverBatch(command.batchPath)) };
  }
  if (command?.type === 'transition_task') {
    if (!command.batchPath || !command.task_id || !command.nextStatus) return { ok: false, status: 'blocked', reason: 'task_transition_input_missing' };
    return { ok: true, task: await transitionTask(command.batchPath, command.task_id, command.nextStatus, command.details) };
  }
  if (command?.type === 'retry_web_monitor') {
    if (!command.confirmed) return { ok: false, status: 'blocked', reason: 'batch_not_confirmed' };
    if (!command.batchPath || !command.task_id) return { ok: false, status: 'blocked', reason: 'task_completion_input_missing' };
    return { ok: true, task: await retryWebMonitorTask(command.batchPath, command.task_id) };
  }
  if (command?.type === 'assign_next_task') {
    if (!command.batchPath || !command.channel) return { ok: false, status: 'blocked', reason: 'task_assignment_input_missing' };
    return { ok: true, task: await assignNextTask(command.batchPath, command.channel) };
  }
  if (command?.type === 'complete_task_and_assign_next') {
    if (!command.batchPath || !command.task_id || !command.channel) return { ok: false, status: 'blocked', reason: 'task_completion_input_missing' };
    return { ok: true, ...(await completeTaskAndAssignNext(command.batchPath, command.task_id, command.channel, command.details)) };
  }
  if (command?.type === 'register_web_conversation') {
    if (!command.batchPath || !command.task_id || !command.conversationUrl) return { ok: false, status: 'blocked', reason: 'web_conversation_input_missing' };
    return { ok: true, task: await registerWebConversation(command.batchPath, command.task_id, command.conversationUrl) };
  }
  if (command?.type === 'mark_web_ready_to_send') return { ok: true, task: await markWebReadyToSend(command.batchPath, command.task_id) };
  if (command?.type === 'mark_web_manually_sent') return { ok: true, task: await markWebManuallySent(command.batchPath, command.task_id, { confirmed: command.confirmed }) };
  if (command?.type === 'reset_web_preparation') {
    if (!command.confirmed) return { ok: false, status: 'blocked', reason: 'batch_not_confirmed' };
    if (!command.batchPath) return { ok: false, status: 'blocked', reason: 'batch_path_missing' };
    return { ok: true, ...(await resetWebPreparation(command.batchPath)) };
  }
  if (command?.type === 'complete_web_result') {
    if (!command.confirmed) return { ok: false, status: 'blocked', reason: 'batch_not_confirmed' };
    if (!command.batchPath || !command.task_id) return { ok: false, status: 'blocked', reason: 'task_completion_input_missing' };
    return { ok: true, ...(await completeTaskAndAssignNext(command.batchPath, command.task_id, 'web', command.details ?? {})) };
  }
  if (command?.type === 'archive_download') {
    if (!command.confirmed) return { ok: false, status: 'blocked', reason: 'batch_not_confirmed' };
    const path = await archiveDownload(command.batchPath, command);
    return { ok: true, path };
  }
  if (command?.type === 'archive_codex_image') {
    if (!command.confirmed) return { ok: false, status: 'blocked', reason: 'batch_not_confirmed' };
    if (!command.batchPath || !command.task_id || !command.sourcePath) return { ok: false, status: 'blocked', reason: 'codex_result_input_missing' };
    await access(command.sourcePath);
    const loaded = await loadBatch(command.batchPath);
    const task = loaded.tasks.find((item) => item.task_id === command.task_id);
    if (!task) throw new Error('unknown task');
    if (task.status === 'archived') {
      return { ok: true, path: task.artifacts?.at(-1)?.path ?? null, completedTask: task, nextTask: null, alreadyArchived: true };
    }
    let completion = { completedTask: task, nextTask: null, alreadyCompleted: task.status === 'completed' };
    if (task.status === 'generating') {
      completion = await completeTaskAndAssignNext(command.batchPath, command.task_id, 'codex', { channel: 'codex', source_path: command.sourcePath });
    } else if (task.status !== 'completed') {
      throw new Error('codex_completion_requires_generating_task');
    }
    const path = await archiveDownload(command.batchPath, command);
    return { ok: true, path, ...completion };
  }
  throw new Error('unsupported command');
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { buffer += chunk; });
  process.stdin.on('end', async () => {
    for (const line of buffer.split('\n').filter(Boolean)) {
      try { console.log(JSON.stringify(await handleCommand(JSON.parse(line)))); }
      catch (error) { console.log(JSON.stringify({ ok: false, error: error.message })); }
    }
  });
}
