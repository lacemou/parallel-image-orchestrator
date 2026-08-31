import { buildTrustedClickCommands } from './send-click.js';
import { buildNativeComposerInputCommand, waitForPromptLoaded } from './composer-input.js';
import {
  collectPreparedTabs,
  mappingItemsToIds,
  normalizePreparedTabError,
  pendingPreparedTasks,
  preparedStorageKey,
  recoverPreparedTabMapping,
  reconcilePreparedTabs,
  sameChatGPTProjectUrl,
  validatePreparedComposer,
  validatePreparedConversationUrls,
} from './prepared-tabs.js';
import {
  classifyWebResultObservation,
  createWebDownloadTracking,
  ensureSingleImagePrompt,
  normalizeConversationUrl,
  planWebMonitorAction,
  redactDownloadUrl,
  sameChatGPTConversationUrl,
} from './web-monitor.js';

const pendingDownloads = new Map();
const pendingDownloadByTab = new Map();
const monitorRuns = new Set();
const completionRuns = new Set();
const MONITOR_ALARM_NAME = 'pio.web-completion-monitor';
const MONITOR_PERIOD_MINUTES = 0.5;
const MONITOR_BATCHES_KEY = 'pio.monitor.batches';
const MONITOR_DOWNLOADS_KEY = 'pio.monitor.downloads';
const AUTO_RETRYABLE_MONITOR_REASONS = new Set([
  'ambiguous_result',
  'download_unavailable',
  'download_control_unavailable',
  'download_control_ambiguous',
  'prepared_task_tab_missing',
  'conversation_url_mismatch',
  'download_not_started',
  'download_interrupted',
  'direct_download_failed',
  'web_observer_failed',
]);
let monitorStorageChain = Promise.resolve();

ensureMonitorAlarm().catch((error) => console.error('Parallel Image Orchestrator monitor alarm setup failed', error));

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== MONITOR_ALARM_NAME) return;
    monitorGeneratingWebTasks().catch((error) => console.error('Parallel Image Orchestrator web monitor failed', error));
  });
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === 'pio.bridge.preflight') {
    chrome.runtime.sendNativeMessage('com.yj.parallel_image_orchestrator', { type: 'health_check' })
      .then(reply)
      .catch((error) => reply({ ok: false, reason: error.message }));
    return true;
  }
  if (message?.type === 'pio.upload') {
    if (!sender.tab?.id || !message.confirmed) { reply({ ok: false, reason: 'batch_not_confirmed' }); return; }
    uploadAllowlistedFiles(sender.tab.id, message.files, true).then(reply).catch((error) => reply({ ok: false, reason: error.message }));
    return true;
  }
  if (message?.type === 'pio.web.dispatch') {
    reply({ ok: false, reason: 'manual_web_flow_required' });
    return true;
  }
  if (message?.type === 'pio.batch.load') {
    nativeCommand({ type: 'load_batch', batchPath: message.batchPath })
      .then(async (response) => {
        if (!response?.ok) { reply(response); return; }
        const resumed = await resumeRecoverableWebMonitorTasks(message.batchPath, response.manifest);
        const manifest = resumed.manifest ?? response.manifest;
        const monitoring = await registerActiveMonitorForManifest(message.batchPath, manifest);
        const preparedStored = await chrome.storage.local.get(preparedStorageKey(message.batchPath));
        const prepared = preparedStored[preparedStorageKey(message.batchPath)]?.batch_id === manifest.batch_id
          ? preparedStored[preparedStorageKey(message.batchPath)].items ?? {}
          : {};
        reply({ ...response, manifest, monitoring, resumed: resumed.resumed, prepared });
      })
      .catch((error) => reply({ ok: false, reason: error.message }));
    return true;
  }
  if (message?.type === 'pio.batch.start_web') {
    reply({ ok: false, reason: 'manual_web_flow_required' });
    return true;
  }
  if (message?.type === 'pio.batch.prepare_web') {
    prepareWebBatch(message).then(reply).catch((error) => reply(preparedErrorResponse(error)));
    return true;
  }
  if (message?.type === 'pio.batch.fill_prepared_web') {
    fillPreparedWebBatch(message).then(reply).catch((error) => reply(preparedErrorResponse(error)));
    return true;
  }
  if (message?.type === 'pio.batch.reset_web_preparation') {
    resetWebPreparationBatch(message).then(reply).catch((error) => reply({ ok: false, reason: error.message }));
    return true;
  }
  if (message?.type === 'pio.web.register_conversation' || message?.type === 'pio.web.ready' || message?.type === 'pio.web.manually_sent') {
    if (message.type === 'pio.web.manually_sent') {
      confirmWebManualSend(message).then(reply).catch((error) => reply({ ok: false, reason: error.message })); return true;
    }
    const type = message.type === 'pio.web.register_conversation' ? 'register_web_conversation' : message.type === 'pio.web.ready' ? 'mark_web_ready_to_send' : 'mark_web_manually_sent';
    nativeCommand({ type, batchPath: message.batchPath, task_id: message.task_id, conversationUrl: message.conversationUrl, confirmed: message.confirmed })
      .then(reply).catch((error) => reply({ ok: false, reason: error.message }));
    return true;
  }
  if (message?.type === 'pio.web.capture_conversation') {
    captureWebConversation(message).then(reply).catch((error) => reply(preparedErrorResponse(error)));
    return true;
  }
  if (message?.type === 'pio.web.confirm_all_sent') {
    confirmAllWebSent(message).then(reply).catch((error) => reply(preparedErrorResponse(error)));
    return true;
  }
  if (message?.type === 'pio.download.track') {
    if (!message.confirmed || !Number.isInteger(message.downloadId) || !message.batchPath || !message.task_id || !message.channel) {
      reply({ ok: false, reason: 'download_tracking_input_missing' }); return;
    }
    pendingDownloads.set(message.downloadId, { batchPath: message.batchPath, task_id: message.task_id, channel: message.channel });
    reply({ ok: true, status: 'tracking' });
    return;
  }
  if (message?.type === 'pio.monitor.status') {
    getMonitorStatus(message.batchPath).then(reply).catch((error) => reply({ ok: false, reason: error.message }));
    return true;
  }
  if (message?.type === 'pio.web.retry_monitor') {
    retryBlockedWebMonitorTasks(message).then(reply).catch((error) => reply({ ok: false, reason: error.message }));
    return true;
  }
  if (message?.type === 'pio.project.preflight') {
    readCurrentProjectEvidence()
      .then(reply)
      .catch((error) => reply({ projectUrl: null, composerVisible: false, fileInputVisible: false, error: error.message }));
    return true;
  }
});

function nativeCommand(command) {
  return chrome.runtime.sendNativeMessage('com.yj.parallel_image_orchestrator', command);
}

function preparedErrorResponse(error) {
  const normalized = normalizePreparedTabError(error);
  if (normalized.code === 'prepared_task_tab_missing') return { ok: false, status: 'needs_reprepare', reason: normalized.code };
  if (normalized.message === 'prompt_dom_insert_failed') return { ok: false, status: 'needs_user_action', reason: 'prompt_not_loaded' };
  return { ok: false, status: 'error', reason: normalized.message };
}

async function prepareWebBatch({ batchPath, projectUrl, confirmed }) {
  if (!confirmed || !batchPath || !/^https:\/\/chatgpt\.com\/g\/[^/]+\/project\/?$/.test(projectUrl || '')) throw new Error('web_prepare_input_invalid');
  const loaded = await nativeCommand({ type: 'load_batch', batchPath });
  if (!loaded?.ok) throw new Error(loaded?.reason || 'batch_load_failed');
  const tasks = loaded.manifest.tasks.filter((task) => task.assigned_channel === 'web' && task.status === 'queued');
  if (!tasks.length) return { ok: true, status: 'no_pending_web_tasks', results: [] };
  const storageKey = preparedStorageKey(batchPath);
  const stored = await chrome.storage.local.get(storageKey);
  const saved = stored[storageKey];
  const previousMapping = saved?.batch_id === loaded.manifest.batch_id ? mappingItemsToIds(saved.items) : {};
  const recovered = await recoverPreparedTabsForTasks({ tasks, mapping: previousMapping, saved, projectUrl });
  const reconciled = await reconcilePreparedTabs(
    tasks,
    recovered.mapping,
    (tabId) => chrome.tabs.get(tabId),
    async () => {
      // Opening a page and having a usable composer are separate states. Keep
      // the page even when ChatGPT is slow or offline so the user can reload it.
      return chrome.tabs.create({ url: projectUrl, active: false });
    },
    (tab) => isTabInProject(tab, projectUrl),
  );
  await chrome.storage.local.set({ [storageKey]: {
    version: 2,
    batch_id: loaded.manifest.batch_id,
    batch_path: batchPath,
    project_url: projectUrl,
    updated_at: new Date().toISOString(),
    items: {
      ...(saved?.items && typeof saved.items === 'object' ? saved.items : {}),
      ...Object.fromEntries(reconciled.results.map((item) => [item.task_id, { tab_id: item.tab_id, url: item.url, status: item.status }])),
    },
  } });
  return { ok: true, status: 'pages_prepared', results: reconciled.results };
}

async function fillPreparedWebBatch({ batchPath, confirmed }) {
  if (!confirmed) throw new Error('batch_not_confirmed');
  const loaded = await nativeCommand({ type: 'load_batch', batchPath });
  if (!loaded?.ok) throw new Error('batch_load_failed');
  const allTasks = loaded.manifest.tasks.filter((task) => task.assigned_channel === 'web' && task.status === 'queued');
  const storageKey = preparedStorageKey(batchPath);
  const stored = await chrome.storage.local.get(storageKey);
  const saved = stored[storageKey];
  const savedItems = saved?.batch_id === loaded.manifest.batch_id ? saved.items : {};
  const tasks = pendingPreparedTasks(allTasks, savedItems);
  if (!tasks.length) return { ok: true, status: 'already_prepared', results: [] };
  const allowedAttachments = [...new Set(loaded.manifest.tasks
    .filter((task) => task.assigned_channel === 'web')
    .flatMap((task) => task.attachments ?? []))];
  const mapping = saved?.batch_id === loaded.manifest.batch_id ? mappingItemsToIds(saved.items) : {};
  const resolved = await recoverPreparedTabsForTasks({
    tasks,
    mapping,
    saved: saved?.batch_id === loaded.manifest.batch_id ? saved : undefined,
    projectUrl: saved?.project_url,
  });
  if (resolved.recovered.length) await persistPreparedTabRebindings({
    storageKey: preparedStorageKey(batchPath),
    batchPath,
    loaded,
    saved,
    projectUrl: saved?.project_url,
    rows: resolved.rows,
  });
  const collected = resolved;
  if (collected.missing.length) return {
    ok: false,
    status: 'needs_reprepare',
    reason: 'prepared_task_tab_missing',
    missing: collected.missing,
    unresolved: collected.unresolved,
  };
  const rows = collected.rows;
  if (saved?.project_url && rows.some(({ tab }) => !isTabInProject(tab, saved.project_url))) {
    return { ok: false, status: 'needs_user_action', reason: 'prepared_task_wrong_project' };
  }
  const normalized = normalizeConversationUrls(rows.map(({ tab }) => tab.url || ''), { allowProjectHome: true });
  if (!normalized.ok) return { ok: false, status: 'needs_user_action', reason: normalized.reason, details: normalized.details };
  const pageChecks = await inspectPreparedRows(rows);
  if (!pageChecks.ok) return pageChecks;
  const results = [];
  let failedTaskId = null;
  try {
    for (let index = 0; index < rows.length; index += 1) {
      const { task, tab } = rows[index];
      failedTaskId = task.task_id;
      await uploadPreparedTaskAttachments(tab.id, task, allowedAttachments);
      const prompt = task.effective_prompt ?? ensureSingleImagePrompt(task.variable_prompt ?? task.prompt ?? '');
      try {
        await enterPromptWithDebugger(tab.id, prompt);
      } catch (error) {
        // If CDP cannot deliver text to a background tab, use the page's own
        // input event path once. This remains a fill-only fallback and never
        // clicks the send button.
        try {
          await insertPromptWithDom(tab.id, prompt, { replace: true });
        } catch (fallbackError) {
          const normalizedFallback = normalizePreparedTabError(fallbackError);
          if (normalizedFallback.code === 'prepared_task_tab_missing') throw fallbackError;
          throw new Error('prompt_not_loaded');
        }
      }
      try {
        await verifyPromptLoaded(tab.id, prompt);
      } catch (error) {
        if (error?.message !== 'prompt_not_loaded') throw error;
        // A ChatGPT page can expose a hidden textarea alongside the visible
        // contenteditable. Re-focus the visible composer, replace any partial
        // insertion, and retry once before stopping this batch. The DOM path
        // is deliberately used here because CDP input may have been swallowed
        // during a page hydration/rerender race.
        await insertPromptWithDom(tab.id, prompt, { replace: true });
        await verifyPromptLoaded(tab.id, prompt).catch(() => { throw error; });
      }
      const result = { task_id: task.task_id, tab_id: tab.id, url: normalized.urls[index], status: 'awaiting_manual_send', prompt_status: 'loaded' };
      results.push(result);
      const previous = savedItems[task.task_id] && typeof savedItems[task.task_id] === 'object' ? savedItems[task.task_id] : {};
      savedItems[task.task_id] = { ...previous, tab_id: tab.id, url: normalized.urls[index], status: result.status, filled_at: new Date().toISOString() };
      await chrome.storage.local.set({ [preparedStorageKey(batchPath)]: { ...saved, updated_at: new Date().toISOString(), items: savedItems } });
    }
  } catch (error) {
    const normalizedError = normalizePreparedTabError(error);
    const rawReason = String(error?.message || normalizedError.message);
    const reason = rawReason === 'prompt_dom_insert_failed' ? 'prompt_not_loaded' : rawReason;
    return {
      ok: false,
      status: normalizedError.code === 'prepared_task_tab_missing' ? 'needs_reprepare' : 'needs_user_action',
      reason: normalizedError.code === 'prepared_task_tab_missing' ? normalizedError.code : reason,
      failed_task_id: failedTaskId,
      results,
    };
  }
  return { ok: true, status: 'awaiting_manual_send', results };
}

async function resetWebPreparationBatch({ batchPath, confirmed }) {
  if (!confirmed) return { ok: false, status: 'blocked', reason: 'batch_not_confirmed' };
  if (!batchPath) return { ok: false, status: 'blocked', reason: 'batch_path_missing' };

  const response = await nativeCommand({ type: 'reset_web_preparation', batchPath, confirmed: true });
  if (!response?.ok) return response;
  const resetTaskIds = new Set(Array.isArray(response.reset_task_ids) ? response.reset_task_ids : []);

  // Remove only the preparation entries that were rewound. A generating task
  // may still need its tab mapping for completion monitoring.
  const storageKey = preparedStorageKey(batchPath);
  const stored = await chrome.storage.local.get(storageKey);
  const saved = stored[storageKey];
  if (saved?.items && typeof saved.items === 'object') {
    const items = { ...saved.items };
    for (const taskId of resetTaskIds) delete items[taskId];
    if (Object.keys(items).length) {
      await chrome.storage.local.set({ [storageKey]: { ...saved, updated_at: new Date().toISOString(), items } });
    } else {
      await chrome.storage.local.remove(storageKey);
    }
  }

  await mutateStorageMap(MONITOR_DOWNLOADS_KEY, (states) => {
    for (const key of Object.keys(states)) {
      if (!key.startsWith(`${batchPath}::`)) continue;
      const taskId = key.slice(`${batchPath}::`.length);
      if (resetTaskIds.has(taskId)) delete states[key];
    }
    return null;
  });
  for (const [downloadId, pending] of pendingDownloads) {
    if (pending?.batchPath === batchPath && resetTaskIds.has(pending.task_id)) pendingDownloads.delete(downloadId);
  }
  for (const [tabId, pending] of pendingDownloadByTab) {
    if (pending?.batchPath === batchPath && resetTaskIds.has(pending.task_id)) pendingDownloadByTab.delete(tabId);
  }
  for (const taskId of resetTaskIds) completionRuns.delete(monitorTaskKey(batchPath, taskId));

  const refreshed = await nativeCommand({ type: 'load_batch', batchPath });
  const manifest = refreshed?.ok ? refreshed.manifest : null;
  const active = manifest?.tasks?.some((task) => task.assigned_channel === 'web'
    && task.status === 'generating'
    && task.web_conversation_url);
  let monitoring = false;
  if (active) {
    monitoring = await registerActiveMonitorForManifest(batchPath, manifest);
  } else {
    await mutateStorageMap(MONITOR_BATCHES_KEY, (batches) => {
      delete batches[batchPath];
      return null;
    });
  }
  return manifest ? { ...response, monitoring, manifest } : { ...response, monitoring };
}

function normalizeConversationUrls(urls, options) {
  return validatePreparedConversationUrls(urls, options);
}

function isTabInProject(tab, projectUrl) {
  return sameChatGPTProjectUrl(tab?.url, projectUrl);
}

async function inspectPreparedTabPrompt(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const selectors = [
          '[data-message-author-role="user"]',
          '[data-testid*="conversation-turn-user"]',
          '[data-testid*="user-turn"]',
        ];
        const nodes = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
        const texts = [...new Set(nodes.map((node) => String(node.innerText ?? node.textContent ?? '').trim()).filter(Boolean))];
        const fallback = String(document.body?.innerText ?? '').trim();
        const promptText = texts.length ? texts[texts.length - 1] : fallback;
        return { promptText: promptText.slice(-20000) };
      },
    });
    return result?.promptText ?? '';
  } catch {
    return '';
  }
}

async function discoverPreparedConversationTabs(projectUrl, excludedTabIds = new Set()) {
  const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/g/*/c/*'] });
  const candidates = tabs.filter((tab) => Number.isInteger(tab.id) && !excludedTabIds.has(tab.id) && isTabInProject(tab, projectUrl));
  return Promise.all(candidates.map(async (tab) => ({
    ...tab,
    promptText: await inspectPreparedTabPrompt(tab.id),
  })));
}

async function recoverPreparedTabsForTasks({ tasks, mapping, saved, projectUrl }) {
  const current = await collectPreparedTabs(tasks, mapping, (tabId) => chrome.tabs.get(tabId));
  if (!current.missing.length || !projectUrl) return { ...current, mapping, recovered: [], unresolved: [] };
  const liveTabIds = new Set(current.rows.map(({ tab }) => tab.id));
  const candidates = await discoverPreparedConversationTabs(projectUrl, liveTabIds);
  const missingTaskIds = new Set(current.missing.map(({ task_id }) => task_id));
  const missingTasks = tasks.filter((task) => missingTaskIds.has(task.task_id));
  const repaired = recoverPreparedTabMapping(missingTasks, saved?.items, candidates);
  const repairedMapping = { ...(mapping ?? {}), ...repaired.mapping };
  const recollected = await collectPreparedTabs(tasks, repairedMapping, (tabId) => chrome.tabs.get(tabId));
  return { ...recollected, mapping: repairedMapping, recovered: repaired.recovered, unresolved: repaired.unresolved };
}

async function persistPreparedTabRebindings({ storageKey, batchPath, loaded, saved, projectUrl, rows }) {
  if (!rows.length) return saved;
  const previousItems = saved?.items && typeof saved.items === 'object' ? saved.items : {};
  const items = { ...previousItems };
  for (const { task, tab } of rows) {
    const previous = items[task.task_id] && typeof items[task.task_id] === 'object' ? items[task.task_id] : {};
    items[task.task_id] = {
      ...previous,
      tab_id: tab.id,
      url: tab.url ?? previous.url ?? null,
    };
  }
  const rebound = {
    ...(saved && typeof saved === 'object' ? saved : {}),
    version: saved?.version ?? 2,
    batch_id: loaded.manifest.batch_id,
    batch_path: batchPath,
    project_url: projectUrl ?? saved?.project_url ?? null,
    updated_at: new Date().toISOString(),
    items,
  };
  await chrome.storage.local.set({ [storageKey]: rebound });
  return rebound;
}

async function inspectPreparedRows(rows) {
  const checks = await Promise.all(rows.map(async ({ task, tab }) => {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const isVisible = (element) => {
            if (!element || !element.getClientRects().length) return false;
            const style = getComputedStyle(element);
            return style.display !== 'none'
              && style.visibility !== 'hidden'
              && style.opacity !== '0'
              && (element.offsetParent !== null || style.position === 'fixed');
          };
          const composer = [...document.querySelectorAll('#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"], textarea')]
            .find(isVisible);
          if (!composer) return { composerVisible: false, draft: '' };
          const draft = 'value' in composer ? composer.value : composer.innerText ?? composer.textContent ?? '';
          return { composerVisible: true, draft: String(draft ?? '') };
        },
      });
      const validation = validatePreparedComposer(result);
      return validation.ok ? { task_id: task.task_id, ok: true } : { task_id: task.task_id, ...validation };
    } catch (error) {
      const normalized = normalizePreparedTabError(error);
      return { task_id: task.task_id, ok: false, reason: normalized.code };
    }
  }));
  const failed = checks.filter((check) => !check.ok);
  if (failed.length) {
    const missing = failed.filter((check) => check.reason === 'prepared_task_tab_missing');
    return {
      ok: false,
      status: missing.length ? 'needs_reprepare' : 'needs_user_action',
      reason: failed[0].reason,
      details: failed,
    };
  }
  return { ok: true };
}

async function captureWebConversation({ batchPath, task_id }) {
  const loaded = await nativeCommand({ type: 'load_batch', batchPath });
  if (!loaded?.ok) throw new Error('batch_load_failed');
  const storageKey = preparedStorageKey(batchPath);
  const stored = await chrome.storage.local.get(storageKey);
  const saved = stored[storageKey];
  const tabId = saved?.batch_id === loaded.manifest.batch_id ? mappingItemsToIds(saved.items)?.[task_id] : null;
  if (!Number.isInteger(tabId)) return { ok: false, reason: 'prepared_task_tab_missing', status: 'needs_reprepare', task_id };
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch (error) {
    const normalized = normalizePreparedTabError(error);
    return { ok: false, reason: normalized.code, status: 'needs_reprepare', task_id, tab_id: tabId };
  }
  const normalized = normalizeConversationUrls([tab.url || ''], { allowProjectHome: false });
  if (!normalized.ok) return { ok: false, status: 'needs_user_action', reason: normalized.reason };
  const response = await nativeCommand({ type: 'register_web_conversation', batchPath, task_id, conversationUrl: normalized.urls[0] });
  if (!response?.ok) return response;
  const task = loaded?.manifest?.tasks?.find((item) => item.task_id === task_id);
  if (!task?.variable_prompt && !task?.prompt) return { ok: false, reason: 'task_prompt_missing' };
  await uploadPreparedTaskAttachments(tabId, task, task.attachments ?? []);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId }, args: [task.effective_prompt ?? ensureSingleImagePrompt(task.variable_prompt ?? task.prompt)],
    func: (prompt) => {
      const isVisible = (element) => {
        if (!element || !element.getClientRects().length) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0'
          && (element.offsetParent !== null || style.position === 'fixed');
      };
      const composer = [...document.querySelectorAll('#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"], textarea')]
        .find(isVisible);
      if (!composer) return { ok: false, reason: 'composer_not_visible' };
      composer.focus(); document.execCommand('insertText', false, prompt);
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
      return { ok: true };
    },
  });
  if (!result?.ok) return result;
  const prompt = task.effective_prompt ?? ensureSingleImagePrompt(task.variable_prompt ?? task.prompt);
  const promptCheck = await verifyPromptLoaded(tabId, prompt).catch((error) => ({ ok: false, reason: error.message }));
  if (!promptCheck?.ok) return promptCheck;
  return nativeCommand({ type: 'mark_web_ready_to_send', batchPath, task_id });
}

async function uploadPreparedTaskAttachments(tabId, task, allowedAttachments) {
  const files = Array.isArray(task?.attachments) ? task.attachments : [];
  if (!files.length) return;
  const allowed = new Set(allowedAttachments ?? []);
  if (files.some((file) => !allowed.has(file))) throw new Error('attachment_not_allowlisted');
  await uploadAllowlistedFiles(tabId, files, true);
}

async function confirmWebManualSend({ batchPath, task_id, confirmed }) {
  if (!confirmed) throw new Error('batch_not_confirmed');
  const loaded = await nativeCommand({ type: 'load_batch', batchPath });
  if (!loaded?.ok) throw new Error('batch_load_failed');
  const task = loaded.manifest.tasks.find((item) => item.task_id === task_id);
  if (!task) throw new Error('task_not_found');
  if (task.status === 'generating') {
    const stored = await chrome.storage.local.get(preparedStorageKey(batchPath));
    const saved = stored[preparedStorageKey(batchPath)];
    await registerMonitorBatch({
      batchPath,
      batchId: loaded.manifest.batch_id,
      projectUrl: saved?.project_url ?? deriveProjectUrl(task.web_conversation_url),
    });
    return { ok: true, status: 'already_generating', task };
  }
  const storageKey = preparedStorageKey(batchPath);
  const stored = await chrome.storage.local.get(storageKey);
  const saved = stored[storageKey];
  const tabId = saved?.batch_id === loaded.manifest.batch_id ? mappingItemsToIds(saved.items)?.[task_id] : null;
  if (!Number.isInteger(tabId)) return { ok: false, reason: 'prepared_task_tab_missing', status: 'needs_reprepare', task_id };
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch (error) {
    const normalized = normalizePreparedTabError(error);
    return { ok: false, reason: normalized.code, status: 'needs_reprepare', task_id, tab_id: tabId };
  }
  const normalized = normalizeConversationUrls([tab.url || ''], { allowProjectHome: false });
  if (!normalized.ok) return { ok: false, status: 'needs_user_action', reason: normalized.reason };
  if (task.status === 'ready_to_send' && task.web_conversation_url !== normalized.urls[0]) {
    return { ok: false, status: 'needs_user_action', reason: 'conversation_url_mismatch' };
  }
  if (task.status === 'queued') {
    const registered = await nativeCommand({ type: 'register_web_conversation', batchPath, task_id, conversationUrl: normalized.urls[0] });
    if (!registered?.ok) throw new Error(registered.reason || 'conversation_register_failed');
    const ready = await nativeCommand({ type: 'mark_web_ready_to_send', batchPath, task_id });
    if (!ready?.ok) throw new Error(ready.reason || 'web_ready_state_failed');
  }
  const sent = await nativeCommand({ type: 'mark_web_manually_sent', batchPath, task_id, confirmed: true });
  if (sent?.ok) {
    const refreshed = await nativeCommand({ type: 'load_batch', batchPath });
    const active = refreshed?.manifest?.tasks?.find((item) => item.task_id === task_id && item.status === 'generating');
    if (active) await registerMonitorBatch({
      batchPath,
      batchId: refreshed.manifest.batch_id,
      projectUrl: saved?.project_url ?? deriveProjectUrl(active.web_conversation_url),
    });
  }
  return sent;
}

async function confirmAllWebSent({ batchPath, confirmed }) {
  if (!confirmed) throw new Error('batch_not_confirmed');
  const loaded = await nativeCommand({ type: 'load_batch', batchPath });
  if (!loaded?.ok) throw new Error('batch_load_failed');
  const resumed = await resumeRecoverableWebMonitorTasks(batchPath, loaded.manifest);
  if (resumed.resumed.length) loaded.manifest = resumed.manifest;
  const tasks = loaded.manifest.tasks.filter((task) => task.assigned_channel === 'web' && ['queued', 'ready_to_send'].includes(task.status));
  const storageKey = preparedStorageKey(batchPath);
  const stored = await chrome.storage.local.get(storageKey);
  const saved = stored[storageKey];
  if (!tasks.length) {
    const active = loaded.manifest.tasks.filter((task) => task.assigned_channel === 'web' && task.status === 'generating' && task.web_conversation_url);
    const monitoring = active.length > 0 && await registerMonitorBatch({
      batchPath,
      batchId: loaded.manifest.batch_id,
      projectUrl: saved?.project_url ?? deriveProjectUrl(active[0]?.web_conversation_url),
    });
    return { ok: true, status: monitoring ? 'monitoring_started' : 'no_pending_web_sends', results: [], monitoring };
  }
  const mapping = saved?.batch_id === loaded.manifest.batch_id ? mappingItemsToIds(saved.items) : {};
  const resolved = await recoverPreparedTabsForTasks({
    tasks,
    mapping,
    saved: saved?.batch_id === loaded.manifest.batch_id ? saved : undefined,
    projectUrl: saved?.project_url,
  });
  if (resolved.recovered.length) await persistPreparedTabRebindings({
    storageKey,
    batchPath,
    loaded,
    saved,
    projectUrl: saved?.project_url,
    rows: resolved.rows,
  });
  const collected = resolved;
  if (collected.missing.length) {
    return {
      ok: false,
      status: 'needs_reprepare',
      reason: 'prepared_task_tab_missing',
      missing: collected.missing,
      unresolved: collected.unresolved,
    };
  }
  if (saved?.project_url && collected.rows.some(({ tab }) => !isTabInProject(tab, saved.project_url))) {
    return { ok: false, status: 'needs_user_action', reason: 'prepared_task_wrong_project' };
  }
  const normalized = normalizeConversationUrls(collected.rows.map(({ tab }) => tab.url || ''), { allowProjectHome: false });
  if (!normalized.ok) return { ok: false, status: 'needs_user_action', reason: normalized.reason, details: normalized.details };
  const results = [];
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    try {
      const tab = collected.rows.find(({ task: rowTask }) => rowTask.task_id === task.task_id)?.tab;
      if (!tab) throw new Error('prepared_task_tab_missing');
      if (task.status === 'queued') {
        const registered = await nativeCommand({ type: 'register_web_conversation', batchPath, task_id: task.task_id, conversationUrl: normalized.urls[index] });
        if (!registered?.ok) throw new Error(registered.reason || 'conversation_register_failed');
        const ready = await nativeCommand({ type: 'mark_web_ready_to_send', batchPath, task_id: task.task_id });
        if (!ready?.ok) throw new Error(ready.reason || 'web_ready_state_failed');
      } else if (task.web_conversation_url !== normalized.urls[index]) {
        throw new Error('conversation_url_mismatch');
      }
      const sent = await nativeCommand({ type: 'mark_web_manually_sent', batchPath, task_id: task.task_id, confirmed: true });
      if (!sent?.ok) throw new Error(sent.reason || 'manual_send_state_failed');
      results.push({ task_id: task.task_id, ok: true });
    } catch (error) { results.push({ task_id: task.task_id, ok: false, reason: error.message }); }
  }
  const refreshed = await nativeCommand({ type: 'load_batch', batchPath });
  const active = refreshed?.ok
    ? refreshed.manifest.tasks.filter((task) => task.assigned_channel === 'web' && task.status === 'generating' && task.web_conversation_url)
    : [];
  const monitoring = active.length > 0 && await registerMonitorBatch({
    batchPath,
    batchId: refreshed?.manifest?.batch_id ?? loaded.manifest.batch_id,
    projectUrl: saved?.project_url ?? deriveProjectUrl(active[0]?.web_conversation_url),
  });
  return { ok: results.every((item) => item.ok), status: results.every((item) => item.ok) ? 'sent_and_monitoring' : 'needs_reprepare', results, monitoring };
}

async function readCurrentProjectEvidence() {
  const target = await findCurrentProjectTab();
  if (!target?.id) return { projectUrl: null, composerVisible: false, fileInputVisible: false };
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: target.id },
    func: () => {
      const isVisible = (element) => {
        if (!element || !element.getClientRects().length) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0'
          && (element.offsetParent !== null || style.position === 'fixed');
      };
      const composer = [...document.querySelectorAll('#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"], textarea')]
        .find(isVisible);
      return { projectUrl: location.href, composerVisible: Boolean(composer), fileInputVisible: Boolean(document.querySelector('input[type="file"]')) };
    },
  });
  return result;
}

async function findCurrentProjectTab() {
  const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/g/*/project*'] });
  return tabs.find((tab) => /^https:\/\/chatgpt\.com\/g\/[^/]+\/project\/?$/.test(tab.url || ''));
}

async function waitForSendAccepted(tabId, prompt, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [prompt],
      func: (promptText) => {
        const isVisible = (element) => {
          if (!element || !element.getClientRects().length) return false;
          const style = getComputedStyle(element);
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && style.opacity !== '0'
            && (element.offsetParent !== null || style.position === 'fixed');
        };
        const composer = [...document.querySelectorAll('#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"], textarea')]
          .find(isVisible);
        const draft = composer?.value ?? composer?.innerText ?? composer?.textContent ?? '';
        const stopVisible = [...document.querySelectorAll('button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止"]')]
          .some((button) => button.getClientRects().length && !button.disabled);
        return stopVisible || !String(draft).includes(promptText);
      },
    });
    if (result) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('send_not_accepted');
}

function isAllowlisted(files, allowedAttachments) {
  const allowed = new Set(allowedAttachments ?? []);
  return Array.isArray(files) && files.every((file) => allowed.has(file));
}

async function dispatchConfirmedWebTask({ confirmed, loginConfirmed, task_id, prompt, attachments = [], allowedAttachments = [], tabId = null }) {
  if (!confirmed || !loginConfirmed) throw new Error('batch_or_login_not_confirmed');
  if (!task_id || !prompt) throw new Error('task_input_missing');
  if (!isAllowlisted(attachments, allowedAttachments)) throw new Error('attachment_not_allowlisted');
  const target = tabId ? await chrome.tabs.get(tabId) : await findCurrentProjectTab();
  if (!target?.id) throw new Error('project_tab_not_found');
  if (!/^https:\/\/chatgpt\.com\/g\/[^/]+\/project\/?$/.test(target.url || '')) throw new Error('invalid_project_url');
  if (attachments.length) await uploadAllowlistedFiles(target.id, attachments, true);
  await enterPromptWithDebugger(target.id, prompt);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: target.id },
    args: [task_id],
    func: (task_id) => {
      const isVisible = (element) => {
        if (!element || !element.getClientRects().length) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0'
          && (element.offsetParent !== null || style.position === 'fixed');
      };
      const composer = [...document.querySelectorAll('#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"], textarea')]
        .find(isVisible);
      if (!composer) return { ok: false, reason: 'composer_not_visible' };
      const send = [...document.querySelectorAll('button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="发送"]')]
        .find((button) => isVisible(button) && !button.disabled);
      if (!send || send.disabled) return { ok: false, reason: 'send_button_unavailable' };
      return { ok: true, status: 'send_button_ready', task_id };
    },
  });
  if (result?.ok) {
    await clickSendButtonWithDebugger(target.id);
    await waitForSendAccepted(target.id, prompt);
  }
  return result;
}

async function enterPromptWithDebugger(tabId, prompt, { replace = false } = {}) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    // Background tabs can expose both a hidden textarea and the visible
    // contenteditable. Bring the target forward and focus the element that is
    // actually rendered before sending CDP text input.
    try { await chrome.debugger.sendCommand(target, 'Page.bringToFront'); } catch { /* older Chrome versions may omit this command */ }
    const focused = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `(() => {
        const isVisible = (element) => {
          if (!element || !element.getClientRects().length) return false;
          const style = getComputedStyle(element);
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && style.opacity !== '0'
            && (element.offsetParent !== null || style.position === 'fixed');
        };
        const composer = [...document.querySelectorAll('#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"], textarea')]
          .find(isVisible);
        if (!composer) return { ok: false, reason: 'composer_not_visible' };
        composer.focus();
        composer.scrollIntoView?.({ block: 'center', inline: 'nearest' });
        return { ok: true, tag: composer.tagName, id: composer.id || null };
      })()`,
      returnByValue: true,
    });
    if (!focused?.result?.value?.ok) throw new Error(focused?.result?.value?.reason || 'composer_not_visible');
    if (replace) {
      const cleared = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: `(() => {
          const isVisible = (element) => {
            if (!element || !element.getClientRects().length) return false;
            const style = getComputedStyle(element);
            return style.display !== 'none'
              && style.visibility !== 'hidden'
              && style.opacity !== '0'
              && (element.offsetParent !== null || style.position === 'fixed');
          };
          const composer = [...document.querySelectorAll('#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"], textarea')]
            .find(isVisible);
          if (!composer) return { ok: false, reason: 'composer_not_visible' };
          composer.focus();
          if ('value' in composer) {
            const prototype = Object.getPrototypeOf(composer);
            const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
            if (descriptor?.set) descriptor.set.call(composer, '');
            else composer.value = '';
          } else {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(composer);
            selection?.removeAllRanges();
            selection?.addRange(range);
            document.execCommand('delete', false);
          }
          composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
          return { ok: true };
        })()`,
        returnByValue: true,
      });
      if (!cleared?.result?.value?.ok) throw new Error(cleared?.result?.value?.reason || 'composer_not_visible');
    }
    const command = buildNativeComposerInputCommand(prompt);
    await chrome.debugger.sendCommand(target, command.method, command.params);
  } finally {
    await chrome.debugger.detach(target);
  }
}

async function insertPromptWithDom(tabId, prompt, { replace = false } = {}) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [prompt, replace],
    func: (promptText, shouldReplace) => {
      const isVisible = (element) => {
        if (!element || !element.getClientRects().length) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0'
          && (element.offsetParent !== null || style.position === 'fixed');
      };
      const composer = [...document.querySelectorAll('#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"], textarea')]
        .find(isVisible);
      if (!composer) return { ok: false, reason: 'composer_not_visible' };
      composer.focus();

      const selection = window.getSelection?.();
      const selectContents = () => {
        if (!selection) return;
        const range = document.createRange();
        range.selectNodeContents(composer);
        selection.removeAllRanges();
        selection.addRange(range);
      };
      const collapseToEnd = () => {
        if (!selection) return;
        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      };
      const dispatchInput = (inputType, data) => {
        try {
          composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data }));
        } catch {
          composer.dispatchEvent(new Event('input', { bubbles: true }));
        }
      };
      const readDraft = () => String(composer.innerText ?? composer.textContent ?? '');

      if ('value' in composer && !composer.isContentEditable) {
        const prototype = Object.getPrototypeOf(composer);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        const setter = descriptor?.set;
        const current = String(composer.value ?? '');
        const next = shouldReplace ? String(promptText ?? '') : `${current}${String(promptText ?? '')}`;
        if (setter) setter.call(composer, next);
        else composer.value = next;
        dispatchInput(shouldReplace ? 'insertText' : 'insertText', String(promptText ?? ''));
        return { ok: true, method: 'dom_value', draft: String(composer.value ?? '') };
      }

      if (shouldReplace) {
        selectContents();
        const deleted = document.execCommand?.('delete', false);
        if (!deleted || String(composer.textContent ?? '')) composer.textContent = '';
        collapseToEnd();
      }
      let inserted = false;
      try {
        inserted = Boolean(document.execCommand?.('insertText', false, String(promptText ?? '')));
      } catch {
        inserted = false;
      }
      const expected = String(promptText ?? '').replace(/\s+/g, ' ').trim();
      const actual = readDraft().replace(/\s+/g, ' ').trim();
      let usedTextNode = false;
      if (!inserted || !expected || !actual.includes(expected)) {
        usedTextNode = true;
        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(false);
        const textNode = document.createTextNode(String(promptText ?? ''));
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      dispatchInput('insertText', String(promptText ?? ''));
      return {
        ok: true,
        method: usedTextNode ? 'dom_text_node' : 'exec_command',
        draft: readDraft(),
      };
    },
  });
  if (!result?.ok) throw new Error(result?.reason || 'prompt_dom_insert_failed');
  return result;
}

async function verifyPromptLoaded(tabId, prompt) {
  return waitForPromptLoaded(async () => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const isVisible = (element) => {
          if (!element || !element.getClientRects().length) return false;
          const style = getComputedStyle(element);
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && style.opacity !== '0'
            && (element.offsetParent !== null || style.position === 'fixed');
        };
        const composer = [...document.querySelectorAll('#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"], textarea')]
          .find(isVisible);
        if (!composer) return '';
        return 'value' in composer ? composer.value : composer.innerText ?? composer.textContent ?? '';
      },
    });
    return result ?? '';
  }, prompt);
}

async function findVisibleDomNode(target, rootNodeId, selector) {
  const result = await chrome.debugger.sendCommand(target, 'DOM.querySelectorAll', { nodeId: rootNodeId, selector });
  for (const nodeId of result.nodeIds ?? []) {
    try {
      const box = await chrome.debugger.sendCommand(target, 'DOM.getBoxModel', { nodeId });
      if (box?.model?.content?.length >= 8) return nodeId;
    } catch { /* hidden or detached candidates are skipped */ }
  }
  return null;
}

async function clickSendButtonWithDebugger(tabId) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    const documentNode = await chrome.debugger.sendCommand(target, 'DOM.getDocument');
    const nodeId = await findVisibleDomNode(target, documentNode.root.nodeId, 'button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="发送"]');
    if (!nodeId) throw new Error('send_button_unavailable');
    const boxModel = await chrome.debugger.sendCommand(target, 'DOM.getBoxModel', { nodeId });
    for (const command of buildTrustedClickCommands(boxModel.model)) await chrome.debugger.sendCommand(target, command.method, command.params);
  } finally {
    await chrome.debugger.detach(target);
  }
}

async function startConfirmedWebBatch({ batchPath, confirmed, loginConfirmed, projectUrl }) {
  if (!confirmed || !loginConfirmed) throw new Error('batch_or_login_not_confirmed');
  if (!batchPath) throw new Error('batch_path_missing');
  if (!/^https:\/\/chatgpt\.com\/g\/[^/]+\/project\/?$/.test(projectUrl || '')) throw new Error('invalid_project_url');
  const loaded = await nativeCommand({ type: 'load_batch', batchPath });
  if (!loaded?.ok) throw new Error(loaded?.reason || 'batch_load_failed');
  const tasks = loaded.manifest.tasks.filter((task) => task.assigned_channel === 'web' && task.status === 'queued');
  const allowedAttachments = [...new Set(tasks.flatMap((task) => task.attachments ?? []))];
  const results = await Promise.all(tasks.map(async (task) => {
    const transitioned = await nativeCommand({ type: 'transition_task', batchPath, task_id: task.task_id, nextStatus: 'dispatching' });
    if (!transitioned?.ok) return { task_id: task.task_id, ok: false, reason: transitioned?.reason || 'dispatch_state_failed' };
    try {
      const tab = await chrome.tabs.create({ url: projectUrl, active: false });
      await waitForProjectComposer(tab.id);
      const result = await dispatchConfirmedWebTask({ confirmed: true, loginConfirmed: true, task_id: task.task_id, prompt: task.effective_prompt ?? ensureSingleImagePrompt(task.variable_prompt ?? task.prompt), attachments: task.attachments ?? [], allowedAttachments, tabId: tab.id });
      if (!result?.ok) throw new Error(result?.reason || 'dispatch_failed');
      const generating = await nativeCommand({ type: 'transition_task', batchPath, task_id: task.task_id, nextStatus: 'generating' });
      if (!generating?.ok) throw new Error(generating?.reason || 'generation_state_failed');
      return { task_id: task.task_id, ok: true, tab_id: tab.id };
    } catch (error) {
      await nativeCommand({ type: 'transition_task', batchPath, task_id: task.task_id, nextStatus: 'blocked', details: { reason: error.message } });
      return { task_id: task.task_id, ok: false, reason: error.message };
    }
  }));
  return { ok: true, results };
}

function monitorTaskKey(batchPath, taskId) {
  return `${String(batchPath)}::${String(taskId)}`;
}

async function readStorageMap(key) {
  const stored = await chrome.storage.local.get(key);
  const value = stored?.[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function writeStorageMap(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

function persistableMonitorDownloadState(state) {
  const persisted = { ...(state ?? {}) };
  const sourceUrl = persisted.sourceUrl;
  const downloadUrl = persisted.downloadUrl;
  delete persisted.sourceUrl;
  delete persisted.downloadUrl;
  if (persisted.image && typeof persisted.image === 'object') {
    const image = { ...persisted.image };
    const imageHint = redactDownloadUrl(image.src);
    if (imageHint) image.src = imageHint;
    else delete image.src;
    persisted.image = image;
  }
  const sourceHint = redactDownloadUrl(sourceUrl);
  const downloadHint = redactDownloadUrl(downloadUrl);
  if (sourceHint) persisted.source_url_hint = sourceHint;
  if (downloadHint) persisted.download_url_hint = downloadHint;
  return persisted;
}

function mutateStorageMap(key, mutator) {
  const operation = monitorStorageChain.then(async () => {
    const current = await readStorageMap(key);
    const result = await mutator(current);
    await chrome.storage.local.set({ [key]: current });
    return result;
  });
  monitorStorageChain = operation.catch(() => undefined);
  return operation;
}

async function ensureMonitorAlarm() {
  if (!chrome.alarms?.get || !chrome.alarms?.create) return false;
  const existing = await chrome.alarms.get(MONITOR_ALARM_NAME);
  if (!existing) await chrome.alarms.create(MONITOR_ALARM_NAME, { periodInMinutes: MONITOR_PERIOD_MINUTES });
  return true;
}

function normalizeProjectUrl(url) {
  const value = normalizeConversationUrl(url);
  return /^https:\/\/chatgpt\.com\/g\/[^/]+\/project\/?$/.test(value) ? value : null;
}

function deriveProjectUrl(conversationUrl) {
  try {
    const parsed = new URL(conversationUrl);
    const match = parsed.pathname.match(/^\/g\/([^/]+)\/c\/[^/]+\/?$/);
    return match ? `${parsed.origin}/g/${match[1]}/project` : null;
  } catch {
    return null;
  }
}

async function registerMonitorBatch({ batchPath, batchId, projectUrl }) {
  const normalizedProjectUrl = normalizeProjectUrl(projectUrl);
  if (!batchPath || !batchId || !normalizedProjectUrl) return false;
  const batches = await readStorageMap(MONITOR_BATCHES_KEY);
  const existing = batches[batchPath];
  if (existing?.batch_id === batchId && existing?.project_url === normalizedProjectUrl) {
    await ensureMonitorAlarm();
    return true;
  }
  batches[batchPath] = {
    batch_id: batchId,
    project_url: normalizedProjectUrl,
    confirmed_at: batches[batchPath]?.confirmed_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await writeStorageMap(MONITOR_BATCHES_KEY, batches);
  await ensureMonitorAlarm();
  monitorGeneratingWebTasks({ onlyBatchPath: batchPath }).catch((error) => console.error('Parallel Image Orchestrator immediate web monitor failed', error));
  return true;
}

async function registerActiveMonitorForManifest(batchPath, manifest) {
  const active = manifest?.tasks?.filter((task) => task.assigned_channel === 'web' && task.status === 'generating' && task.web_conversation_url) ?? [];
  if (!active.length) return false;
  const storageKey = preparedStorageKey(batchPath);
  const stored = await chrome.storage.local.get(storageKey);
  const saved = stored[storageKey]?.batch_id === manifest.batch_id ? stored[storageKey] : undefined;
  return registerMonitorBatch({
    batchPath,
    batchId: manifest.batch_id,
    projectUrl: saved?.project_url ?? deriveProjectUrl(active[0].web_conversation_url),
  });
}

async function resumeRecoverableWebMonitorTasks(batchPath, manifest) {
  const candidates = manifest?.tasks?.filter((task) => task.assigned_channel === 'web'
    && task.status === 'blocked'
    && task.web_conversation_url
    && Number(task.monitor_retry_count ?? 0) < 1
    && AUTO_RETRYABLE_MONITOR_REASONS.has(task.last_error?.reason)) ?? [];
  const resumed = [];
  for (const task of candidates) {
    try {
      const result = await nativeCommand({ type: 'retry_web_monitor', batchPath, task_id: task.task_id, confirmed: true });
      if (result?.ok) resumed.push(task.task_id);
    } catch (error) {
      console.error('Parallel Image Orchestrator could not resume web monitor task', task.task_id, error);
    }
  }
  if (!resumed.length) return { manifest, resumed };
  const refreshed = await nativeCommand({ type: 'load_batch', batchPath });
  return { manifest: refreshed?.ok ? refreshed.manifest : manifest, resumed };
}

async function retryBlockedWebMonitorTasks({ batchPath, confirmed }) {
  if (!confirmed) return { ok: false, status: 'blocked', reason: 'batch_not_confirmed' };
  if (!batchPath) return { ok: false, status: 'blocked', reason: 'batch_path_missing' };
  const loaded = await nativeCommand({ type: 'load_batch', batchPath });
  if (!loaded?.ok) return loaded;
  const candidates = loaded.manifest.tasks.filter((task) => task.assigned_channel === 'web'
    && task.status === 'blocked'
    && task.web_conversation_url
    && AUTO_RETRYABLE_MONITOR_REASONS.has(task.last_error?.reason));
  const results = [];
  for (const task of candidates) {
    try {
      const result = await nativeCommand({ type: 'retry_web_monitor', batchPath, task_id: task.task_id, confirmed: true });
      results.push({ task_id: task.task_id, ok: Boolean(result?.ok), reason: result?.reason });
    } catch (error) {
      results.push({ task_id: task.task_id, ok: false, reason: error.message });
    }
  }
  const refreshed = await nativeCommand({ type: 'load_batch', batchPath });
  const monitoring = refreshed?.ok && await registerActiveMonitorForManifest(batchPath, refreshed.manifest);
  return {
    ok: results.every((item) => item.ok),
    status: results.length ? 'monitoring_restarted' : 'no_blocked_web_tasks',
    results,
    monitoring: Boolean(monitoring),
    manifest: refreshed?.manifest ?? loaded.manifest,
  };
}

async function getMonitorStatus(batchPath) {
  const batches = await readStorageMap(MONITOR_BATCHES_KEY);
  const selected = batchPath ? Object.entries(batches).filter(([path]) => path === batchPath) : Object.entries(batches);
  const entries = [];
  for (const [path, entry] of selected) {
    let manifest = null;
    try { manifest = (await nativeCommand({ type: 'load_batch', batchPath: path }))?.manifest ?? null; } catch { /* keep registry status */ }
    const tasks = manifest?.tasks ?? [];
    entries.push({
      batchPath: path,
      projectUrl: entry.project_url,
      active: tasks.some((task) => task.assigned_channel === 'web' && task.status === 'generating'),
      generating: tasks.filter((task) => task.assigned_channel === 'web' && task.status === 'generating').length,
      completed: tasks.filter((task) => task.assigned_channel === 'web' && task.status === 'completed').length,
      archived: tasks.filter((task) => task.assigned_channel === 'web' && task.status === 'archived').length,
      blocked: tasks.filter((task) => task.assigned_channel === 'web' && task.status === 'blocked').length,
    });
  }
  return { ok: true, active: entries.some((entry) => entry.active), batches: entries };
}

async function monitorGeneratingWebTasks({ onlyBatchPath = null } = {}) {
  const runKey = onlyBatchPath ?? '*';
  if (monitorRuns.has(runKey)) return { ok: true, status: 'already_running' };
  monitorRuns.add(runKey);
  try {
    await retryPendingWebArchives();
    const batches = await readStorageMap(MONITOR_BATCHES_KEY);
    for (const [batchPath, entry] of Object.entries(batches)) {
      if (onlyBatchPath && batchPath !== onlyBatchPath) continue;
      await monitorWebBatch(batchPath, entry);
    }
    return { ok: true, status: 'checked' };
  } finally {
    monitorRuns.delete(runKey);
  }
}

async function monitorWebBatch(batchPath, entry) {
  let loaded;
  try { loaded = await nativeCommand({ type: 'load_batch', batchPath }); } catch (error) {
    console.error('Parallel Image Orchestrator monitor could not load batch', batchPath, error);
    return;
  }
  if (!loaded?.ok || !loaded.manifest) return;
  const resumed = await resumeRecoverableWebMonitorTasks(batchPath, loaded.manifest);
  if (resumed.resumed.length) loaded = { ...loaded, manifest: resumed.manifest };
  const tasks = loaded.manifest.tasks.filter((task) => task.assigned_channel === 'web' && task.status === 'generating' && task.web_conversation_url);
  if (!tasks.length) return;
  const storageKey = preparedStorageKey(batchPath);
  const stored = await chrome.storage.local.get(storageKey);
  const saved = stored[storageKey]?.batch_id === loaded.manifest.batch_id ? stored[storageKey] : undefined;
  const mapping = saved ? mappingItemsToIds(saved.items) : {};
  const downloadStates = await readStorageMap(MONITOR_DOWNLOADS_KEY);
  for (const task of tasks) {
    await monitorWebTask({ batchPath, task, loaded, saved, mapping, downloadStates, projectUrl: entry.project_url ?? saved?.project_url });
  }
}

async function monitorWebTask({ batchPath, task, loaded, saved, mapping, downloadStates, projectUrl }) {
  const key = monitorTaskKey(batchPath, task.task_id);
  const existingDownload = downloadStates[key];
  if (existingDownload && ['requested', 'downloading'].includes(existingDownload.phase)) {
    const requestedAt = Date.parse(existingDownload.requested_at ?? existingDownload.updated_at ?? '');
    if (Number.isFinite(requestedAt) && Date.now() - requestedAt > 120000) {
      await updateMonitorDownloadState(key, { phase: 'failed', error: 'download_not_started' });
      await blockMonitoredWebTask(batchPath, task, 'download_not_started');
    }
    return;
  }
  if (existingDownload && ['downloaded', 'completion_pending', 'archive_pending', 'archive_failed'].includes(existingDownload.phase)) return;

  const resolved = await recoverPreparedTabsForTasks({ tasks: [task], mapping, saved, projectUrl });
  if (resolved.recovered.length) {
    await persistPreparedTabRebindings({
      storageKey: preparedStorageKey(batchPath),
      batchPath,
      loaded,
      saved,
      projectUrl,
      rows: resolved.rows,
    });
  }
  if (resolved.missing.length || resolved.unresolved.length) {
    await blockMonitoredWebTask(batchPath, task, 'prepared_task_tab_missing', { unresolved: resolved.unresolved });
    return;
  }
  const row = resolved.rows[0];
  if (!row?.tab?.id) {
    await blockMonitoredWebTask(batchPath, task, 'prepared_task_tab_missing');
    return;
  }
  let tab = row.tab;
  try { tab = await chrome.tabs.get(row.tab.id); } catch {
    await blockMonitoredWebTask(batchPath, task, 'prepared_task_tab_missing', { tab_id: row.tab.id });
    return;
  }
  const expectedConversationUrl = normalizeConversationUrl(task.web_conversation_url);
  if (!sameChatGPTConversationUrl(tab.url, expectedConversationUrl)) {
    await blockMonitoredWebTask(batchPath, task, 'conversation_url_mismatch', { expected: expectedConversationUrl, actual: normalizeConversationUrl(tab.url) });
    return;
  }

  let observed;
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: observeWebResultPage });
    observed = result;
  } catch (error) {
    console.error('Parallel Image Orchestrator could not inspect web result', task.task_id, error);
    await blockMonitoredWebTask(batchPath, task, 'web_observer_failed');
    return;
  }
  const observation = classifyWebResultObservation({
    conversationUrl: observed?.conversationUrl,
    expectedConversationUrl,
    generating: Boolean(observed?.generating),
    images: observed?.images,
    downloadControls: observed?.downloadControls,
    directDownload: Boolean(observed?.directDownload),
  });
  const downloadRequested = Boolean(existingDownload && ['requested', 'downloading', 'downloaded', 'completion_pending', 'archive_pending', 'archive_failed'].includes(existingDownload.phase));
  const action = planWebMonitorAction({ observation, downloadRequested });
  if (action.status === 'request_download') {
    await requestWebDownload({ batchPath, task, tab, action, downloadStates });
    return;
  }
  if (action.status === 'download_unavailable') {
    const firstObservedAt = existingDownload?.phase === 'awaiting_control' ? existingDownload.first_observed_at : new Date().toISOString();
    const elapsed = Date.now() - Date.parse(firstObservedAt);
    if (!Number.isFinite(elapsed) || elapsed < 120000) {
      const awaiting = {
        ...(existingDownload ?? { batchPath, task_id: task.task_id, channel: 'web', tabId: tab.id }),
        phase: 'awaiting_control',
        first_observed_at: firstObservedAt,
        updated_at: new Date().toISOString(),
      };
      await mutateStorageMap(MONITOR_DOWNLOADS_KEY, (states) => {
        states[key] = awaiting;
        return states[key];
      });
      downloadStates[key] = awaiting;
      return;
    }
  }
  if (['wrong_conversation', 'ambiguous_result', 'download_unavailable'].includes(action.status)) {
    await blockMonitoredWebTask(batchPath, task, action.status, { count: observation.count });
  }
}

async function blockMonitoredWebTask(batchPath, task, reason, details = {}) {
  try {
    await nativeCommand({ type: 'transition_task', batchPath, task_id: task.task_id, nextStatus: 'blocked', details: { reason, ...details } });
  } catch (error) {
    console.error('Parallel Image Orchestrator could not block monitored web task', task.task_id, error);
  }
}

async function requestWebDownload({ batchPath, task, tab, action, downloadStates }) {
  const tracking = createWebDownloadTracking({
    batchPath,
    task_id: task.task_id,
    tabId: tab.id,
    conversationUrl: task.web_conversation_url,
    sourceUrl: action.image?.src,
  });
  if (!tracking) {
    await blockMonitoredWebTask(batchPath, task, 'download_tracking_input_missing');
    return;
  }
  const key = monitorTaskKey(batchPath, task.task_id);
  const state = {
    ...tracking,
    monitorKey: key,
    phase: 'requested',
    image: action.image,
    requested_at: new Date().toISOString(),
  };
  await mutateStorageMap(MONITOR_DOWNLOADS_KEY, (states) => {
    states[key] = persistableMonitorDownloadState(state);
    return states[key];
  });
  downloadStates[key] = state;
  if (action.downloadMode === 'direct' && !action.downloadControl) {
    await requestDirectWebDownload({ key, tracking, state });
    return;
  }
  pendingDownloadByTab.set(tab.id, tracking);
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [action.image?.src ?? ''], func: clickWebDownloadControl });
    if (!result?.ok) throw new Error(result?.reason || 'download_control_unavailable');
  } catch (error) {
    pendingDownloadByTab.delete(tab.id);
    for (const [downloadId, pending] of pendingDownloads) {
      if (pending.monitorKey === key) pendingDownloads.delete(downloadId);
    }
    delete downloadStates[key];
    await mutateStorageMap(MONITOR_DOWNLOADS_KEY, (states) => {
      delete states[key];
      return null;
    });
    await blockMonitoredWebTask(batchPath, task, error.message);
  }
}

async function requestDirectWebDownload({ key, tracking, state }) {
  if (!/^https?:\/\//i.test(String(tracking.sourceUrl ?? ''))) {
    await updateMonitorDownloadState(key, { phase: 'failed', error: 'direct_download_url_invalid' });
    await blockMonitoredWebTask(tracking.batchPath, { task_id: tracking.task_id }, 'direct_download_url_invalid');
    return;
  }
  try {
    const downloadId = await chrome.downloads.download({ url: tracking.sourceUrl, saveAs: false });
    if (!Number.isInteger(downloadId)) throw new Error('download_id_missing');
    const pending = { ...tracking, monitorKey: key, downloadId };
    pendingDownloads.set(downloadId, pending);
    await updateMonitorDownloadState(key, {
      ...state,
      ...pending,
      phase: 'downloading',
      downloadId,
      downloadUrl: tracking.sourceUrl,
    });
    try {
      const [current] = await chrome.downloads.search({ id: downloadId });
      if (current?.state === 'complete') {
        await processCompletedWebDownload(downloadId, pending, current);
      } else if (current?.state === 'interrupted') {
        await handleInterruptedWebDownload(downloadId, pending, { error: { current: current.error || 'download_interrupted' } });
      }
    } catch (error) {
      console.error('Parallel Image Orchestrator direct download reconciliation failed', error);
    }
  } catch (error) {
    await updateMonitorDownloadState(key, { phase: 'failed', error: error.message || 'direct_download_failed' });
    await blockMonitoredWebTask(tracking.batchPath, { task_id: tracking.task_id }, 'direct_download_failed', { error: error.message });
  }
}

function observeWebResultPage() {
  const isVisible = (element) => {
    if (!element || !element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };
  const labelOf = (element) => [element?.getAttribute?.('aria-label'), element?.getAttribute?.('title'), element?.getAttribute?.('data-testid'), element?.innerText, element?.textContent]
    .map((value) => String(value ?? '').trim()).filter(Boolean).join(' ');
  const stopButtons = [...document.querySelectorAll('button[data-testid*="stop"], button[aria-label*="Stop"], button[aria-label*="停止"]')];
  const generating = stopButtons.some((button) => isVisible(button) && !button.disabled)
    || [...document.querySelectorAll('[aria-busy="true"], [data-state="streaming"]')].some(isVisible);
  const selectors = [
    '[data-turn="assistant"]',
    '[data-message-author-role="assistant"]',
    '[data-testid*="conversation-turn-assistant"]',
    '[data-testid*="assistant-turn"]',
  ];
  const turns = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))].filter(isVisible);
  const latest = turns.at(-1) ?? null;
  const generatedRootSelector = '[id^="image-"], [data-testid*="image-gen-image"], .group\\/imagegen-image';
  const rootScope = latest ?? document;
  let generatedRoots = [...new Set([...rootScope.querySelectorAll(generatedRootSelector)])].filter(isVisible);
  if (!latest && !generatedRoots.length) generatedRoots = [...new Set([...document.querySelectorAll(generatedRootSelector)])].filter(isVisible);
  const imagesFromRoot = (root) => {
    const candidates = [...root.querySelectorAll('img')].filter(isVisible);
    const usable = candidates.filter((image) => !image.hasAttribute('aria-hidden'));
    const unique = [...new Map((usable.length ? usable : candidates)
      .map((image) => [image.currentSrc || image.src, image])
      .filter(([src]) => Boolean(src)))
      .values()];
    return unique.map((image) => ({
      src: image.currentSrc || image.src,
      width: image.naturalWidth || image.width || image.getBoundingClientRect().width,
      height: image.naturalHeight || image.height || image.getBoundingClientRect().height,
      kind: 'generated',
      alt: image.alt,
    }));
  };
  let images = generatedRoots.flatMap(imagesFromRoot);
  if (!images.length) {
    const fallbackImages = [...rootScope.querySelectorAll('img')].filter((image) => isVisible(image)
      && !image.hasAttribute('aria-hidden')
      && !/(?:个人资料图片|profile picture|avatar)/i.test(String(image.alt ?? '')));
    images = fallbackImages.map((image) => ({
      src: image.currentSrc || image.src,
      width: image.naturalWidth || image.width || image.getBoundingClientRect().width,
      height: image.naturalHeight || image.height || image.getBoundingClientRect().height,
      kind: 'generated',
      alt: image.alt,
    }));
  }
  const controlScope = generatedRoots.length ? generatedRoots : [rootScope];
  const controls = [...new Set(controlScope.flatMap((scope) => [...scope.querySelectorAll('button,a,[role="button"]')]))]
    .filter((element) => isVisible(element) && !element.disabled && (element.hasAttribute?.('download') || /(download|save|下载|保存)/i.test(labelOf(element))))
    .map((element) => ({ label: labelOf(element).slice(0, 200) }));
  return {
    conversationUrl: location.href,
    generating,
    images,
    downloadControls: controls,
    directDownload: images.length > 0 && images.every((image) => /^https?:\/\//i.test(String(image.src ?? ''))),
  };
}

function clickWebDownloadControl(expectedImageSrc) {
  const labelOf = (element) => [element?.getAttribute?.('aria-label'), element?.getAttribute?.('title'), element?.getAttribute?.('data-testid'), element?.innerText, element?.textContent]
    .map((value) => String(value ?? '').trim()).filter(Boolean).join(' ');
  const selectors = [
    '[data-turn="assistant"]',
    '[data-message-author-role="assistant"]',
    '[data-testid*="conversation-turn-assistant"]',
    '[data-testid*="assistant-turn"]',
  ];
  const isVisible = (element) => element?.getClientRects?.().length && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden';
  const turns = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))].filter(isVisible);
  const latest = turns.at(-1) ?? null;
  const rootSelector = '[id^="image-"], [data-testid*="image-gen-image"], .group\\/imagegen-image';
  const scopeRoot = latest ?? document;
  const roots = [...new Set([...scopeRoot.querySelectorAll(rootSelector)])].filter(isVisible);
  const scopes = roots.length ? roots : [scopeRoot];
  const imageSources = scopes.flatMap((scope) => [...scope.querySelectorAll('img')])
    .filter(isVisible)
    .map((element) => element.currentSrc || element.src).filter(Boolean);
  if (expectedImageSrc && !imageSources.includes(expectedImageSrc)) return { ok: false, reason: 'result_changed' };
  const controls = [...new Set(scopes.flatMap((scope) => [...scope.querySelectorAll('button,a,[role="button"]')]))]
    .filter((element) => isVisible(element) && !element.disabled && (element.hasAttribute?.('download') || /(download|save|下载|保存)/i.test(labelOf(element))));
  if (controls.length !== 1) return { ok: false, reason: controls.length ? 'download_control_ambiguous' : 'download_control_unavailable', count: controls.length };
  const control = controls[0];
  control.scrollIntoView?.({ block: 'center', inline: 'center' });
  control.click();
  return { ok: true, label: labelOf(control).slice(0, 200) };
}

async function updateMonitorDownloadState(key, patch) {
  return mutateStorageMap(MONITOR_DOWNLOADS_KEY, (states) => {
    if (!states[key]) return null;
    const next = { ...states[key], ...patch, updated_at: new Date().toISOString() };
    states[key] = persistableMonitorDownloadState(next);
    return next;
  });
}

async function removeMonitorDownloadState(key) {
  await mutateStorageMap(MONITOR_DOWNLOADS_KEY, (states) => {
    delete states[key];
    return null;
  });
}

async function ensureWebCompletion(pending, download) {
  const details = {
    conversation_url: pending.conversationUrl,
    download_url: redactDownloadUrl(download?.url ?? pending.downloadUrl),
    download_id: download?.id ?? pending.downloadId ?? null,
    image_src: redactDownloadUrl(pending.sourceUrl),
  };
  const result = await nativeCommand({ type: 'complete_web_result', confirmed: true, batchPath: pending.batchPath, task_id: pending.task_id, details });
  if (result?.ok) return result;
  const loaded = await nativeCommand({ type: 'load_batch', batchPath: pending.batchPath });
  const task = loaded?.manifest?.tasks?.find((item) => item.task_id === pending.task_id);
  if (task?.status === 'archived') return { ok: true, completedTask: task, alreadyArchived: true };
  if (task?.status === 'completed') return { ok: true, completedTask: task, nextTask: null, idempotent: true };
  throw new Error(result?.reason || 'web_completion_failed');
}

async function prepareReleasedWebTask(batchPath, nextTask) {
  if (nextTask?.assigned_channel !== 'web') return null;
  const storageKey = preparedStorageKey(batchPath);
  const stored = await chrome.storage.local.get(storageKey);
  const saved = stored[storageKey];
  const projectUrl = saved?.project_url ?? deriveProjectUrl(nextTask.web_conversation_url);
  if (!projectUrl) throw new Error('project_url_missing_for_overflow_web_task');
  const prepared = await prepareWebBatch({ batchPath, projectUrl, confirmed: true });
  if (!prepared?.ok) throw new Error(prepared.reason || 'overflow_web_prepare_failed');
  const filled = await fillPreparedWebBatch({ batchPath, confirmed: true });
  if (!filled?.ok) throw new Error(filled.reason || 'overflow_web_fill_failed');
  return { prepared, filled };
}

async function processCompletedWebDownload(downloadId, pending, download) {
  const key = pending.monitorKey ?? monitorTaskKey(pending.batchPath, pending.task_id);
  if (completionRuns.has(key)) return;
  completionRuns.add(key);
  const sourcePath = download?.filename ?? pending.sourcePath;
  try {
    if (!sourcePath) throw new Error('download_filename_missing');
    await updateMonitorDownloadState(key, {
      ...pending,
      phase: 'downloaded',
      sourcePath,
      downloadId: download?.id ?? downloadId ?? pending.downloadId ?? null,
      downloadUrl: download?.url ?? pending.sourceUrl ?? null,
    });
    const completion = await ensureWebCompletion(pending, download);
    if (!completion.alreadyArchived) {
      let overflowPreparation = Promise.resolve();
      if (completion.nextTask?.assigned_channel === 'web') {
        overflowPreparation = prepareReleasedWebTask(pending.batchPath, completion.nextTask)
          .catch((error) => console.error('Parallel Image Orchestrator overflow web preparation failed', error));
      }
      let archived;
      let archiveError;
      try {
        archived = await nativeCommand({
          type: 'archive_download',
          confirmed: true,
          sourcePath,
          batchPath: pending.batchPath,
          task_id: pending.task_id,
          channel: 'web',
        });
      } catch (error) {
        archiveError = error;
      }
      await overflowPreparation;
      if (archiveError) throw archiveError;
      if (!archived?.ok) throw new Error(archived?.reason || 'archive_failed');
      await updateMonitorDownloadState(key, { phase: 'archived', archivePath: archived.path });
    }
    await removeMonitorDownloadState(key);
    if (Number.isInteger(downloadId)) pendingDownloads.delete(downloadId);
    if (Number.isInteger(pending.tabId)) pendingDownloadByTab.delete(pending.tabId);
  } catch (error) {
    await updateMonitorDownloadState(key, { ...pending, phase: 'archive_failed', sourcePath, error: error.message });
    console.error('Parallel Image Orchestrator web download archive failed', error);
  } finally {
    completionRuns.delete(key);
  }
}

async function retryPendingWebArchives() {
  const states = await readStorageMap(MONITOR_DOWNLOADS_KEY);
  for (const state of Object.values(states)) {
    if (!state?.sourcePath || !['downloaded', 'completion_pending', 'archive_pending', 'archive_failed'].includes(state.phase)) continue;
    await processCompletedWebDownload(state.downloadId ?? null, state, { id: state.downloadId, filename: state.sourcePath, url: state.downloadUrl });
  }
}

async function handleInterruptedWebDownload(downloadId, pending, delta) {
  const key = pending.monitorKey;
  if (key) {
    await updateMonitorDownloadState(key, { phase: 'failed', error: delta.error?.current || 'download_interrupted' });
    await blockMonitoredWebTask(pending.batchPath, { task_id: pending.task_id }, 'download_interrupted', { download_id: downloadId });
  }
  pendingDownloads.delete(downloadId);
  if (Number.isInteger(pending.tabId)) pendingDownloadByTab.delete(pending.tabId);
}

if (chrome.downloads?.onCreated) {
  chrome.downloads.onCreated.addListener(async (download) => {
    try {
      const tabId = Number.isInteger(download?.tabId) && download.tabId >= 0 ? download.tabId : null;
      let tracking = tabId === null ? null : pendingDownloadByTab.get(tabId);
      if (!tracking && download?.url) {
        const matches = [...pendingDownloadByTab.values()].filter((candidate) => candidate.sourceUrl && candidate.sourceUrl === download.url);
        if (matches.length === 1) tracking = matches[0];
      }
      if (!tracking) {
        const states = await readStorageMap(MONITOR_DOWNLOADS_KEY);
        const matches = Object.values(states).filter((candidate) => ['requested', 'downloading'].includes(candidate?.phase)
          && ((tabId !== null && candidate.tabId === tabId)
            || (download?.url && candidate.sourceUrl === download.url)
            || (download?.url && candidate.source_url_hint && candidate.source_url_hint === redactDownloadUrl(download.url))));
        if (matches.length === 1) tracking = matches[0];
      }
      if (!tracking) return;
      const pending = { ...tracking, monitorKey: monitorTaskKey(tracking.batchPath, tracking.task_id), downloadId: download.id };
      pendingDownloads.set(download.id, pending);
      if (tabId !== null) pendingDownloadByTab.delete(tabId);
      await updateMonitorDownloadState(pending.monitorKey, { ...pending, phase: 'downloading', downloadId: download.id, downloadUrl: download.url ?? null });
    } catch (error) {
      console.error('Parallel Image Orchestrator download tracking failed', error);
    }
  });
}

chrome.downloads.onChanged.addListener(async (delta) => {
  let pending = pendingDownloads.get(delta.id);
  if (!pending) {
    const states = await readStorageMap(MONITOR_DOWNLOADS_KEY);
    pending = Object.values(states).find((candidate) => candidate?.downloadId === delta.id) ?? null;
    if (pending) pendingDownloads.set(delta.id, pending);
  }
  if (!pending) return;
  if (delta.state?.current === 'interrupted') {
    await handleInterruptedWebDownload(delta.id, pending, delta);
    return;
  }
  if (delta.state?.current !== 'complete') return;
  try {
    const [download] = await chrome.downloads.search({ id: delta.id });
    if (pending.monitorKey) {
      await processCompletedWebDownload(delta.id, pending, download);
      return;
    }
    if (!download?.filename) throw new Error('download_filename_missing');
    const result = await chrome.runtime.sendNativeMessage('com.yj.parallel_image_orchestrator', {
      type: 'archive_download', confirmed: true, sourcePath: download.filename, ...pending,
    });
    if (!result?.ok) throw new Error(result?.reason || 'archive_failed');
    pendingDownloads.delete(delta.id);
  } catch (error) {
    console.error('Parallel Image Orchestrator download archive failed', error);
  }
});

export async function uploadAllowlistedFiles(tabId, files, confirmed) {
  if (!confirmed || !Array.isArray(files) || files.length === 0) throw new Error('batch_not_confirmed');
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    const documentNode = await chrome.debugger.sendCommand(target, 'DOM.getDocument');
    const found = await chrome.debugger.sendCommand(target, 'DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: 'input[type="file"]' });
    if (!found.nodeId) throw new Error('file_input_not_found');
    await chrome.debugger.sendCommand(target, 'DOM.setFileInputFiles', { nodeId: found.nodeId, files });
    return { ok: true };
  } finally {
    await chrome.debugger.detach(target);
  }
}
