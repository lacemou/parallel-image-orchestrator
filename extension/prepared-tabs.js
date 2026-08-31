export const PREPARED_MAPPING_VERSION = 2;

export function preparedStorageKey(batchPath) {
  return `pio.prepared.v${PREPARED_MAPPING_VERSION}.${batchPath}`;
}

export function normalizePreparedTabError(error) {
  const message = String(error?.message ?? error ?? 'prepared_task_tab_unavailable');
  if (/no tab with id/i.test(message) || message === 'prepared_task_tab_missing') {
    return { code: 'prepared_task_tab_missing', message: 'prepared_task_tab_missing' };
  }
  return { code: 'prepared_task_tab_unavailable', message: message || 'prepared_task_tab_unavailable' };
}

export async function collectPreparedTabs(tasks, mapping, getTab) {
  const rows = [];
  const missing = [];
  const usedTabIds = new Set();
  for (const task of tasks) {
    const tabId = mapping?.[task.task_id];
    if (!Number.isInteger(tabId)) {
      missing.push({ task_id: task.task_id, tab_id: tabId ?? null, reason: 'prepared_task_tab_missing' });
      continue;
    }
    try {
      const tab = await getTab(tabId);
      if (!tab?.id) throw new Error('prepared_task_tab_unavailable');
      if (usedTabIds.has(tab.id)) {
        missing.push({ task_id: task.task_id, tab_id: tabId, reason: 'prepared_task_tab_duplicate' });
        continue;
      }
      usedTabIds.add(tab.id);
      rows.push({ task, tab });
    } catch (error) {
      const normalized = normalizePreparedTabError(error);
      missing.push({ task_id: task.task_id, tab_id: tabId, reason: normalized.code });
    }
  }
  return { rows, missing };
}

export async function reconcilePreparedTabs(tasks, mapping, getTab, createTab, isReusable = () => true) {
  const nextMapping = {};
  const resultByTaskId = new Map();
  const usedTabIds = new Set();
  const missing = [];
  for (const task of tasks) {
    const previousTabId = mapping?.[task.task_id];
    if (Number.isInteger(previousTabId) && !usedTabIds.has(previousTabId)) {
      try {
        const tab = await getTab(previousTabId);
        if (!tab?.id || !isReusable(tab, task)) throw new Error('prepared_task_tab_missing');
        usedTabIds.add(previousTabId);
        nextMapping[task.task_id] = previousTabId;
        resultByTaskId.set(task.task_id, { task_id: task.task_id, tab_id: previousTabId, url: tab.url ?? null, status: 'reused' });
        continue;
      } catch (error) {
        const normalized = normalizePreparedTabError(error);
        if (normalized.code !== 'prepared_task_tab_missing') throw error;
      }
    }
    missing.push({ task, previousTabId });
  }

  const created = await Promise.all(missing.map(async ({ task, previousTabId }) => ({
    task,
    previousTabId,
    tab: await createTab(task),
  })));
  for (const { task, previousTabId, tab } of created) {
    if (!Number.isInteger(tab?.id)) throw new Error('prepared_task_tab_create_failed');
    if (usedTabIds.has(tab.id)) throw new Error('prepared_task_tab_duplicate');
    usedTabIds.add(tab.id);
    nextMapping[task.task_id] = tab.id;
    resultByTaskId.set(task.task_id, { task_id: task.task_id, tab_id: tab.id, url: tab.url ?? null, status: previousTabId ? 'recreated' : 'created' });
  }
  return { mapping: nextMapping, results: tasks.map((task) => resultByTaskId.get(task.task_id)) };
}

export function mappingItemsToIds(items) {
  return Object.fromEntries(Object.entries(items ?? {}).map(([taskId, item]) => [taskId, item?.tab_id ?? item]));
}

export function pendingPreparedTasks(tasks, savedItems) {
  const sourceTasks = tasks ?? [];
  const recordedTabIds = new Set();
  for (const task of sourceTasks) {
    const saved = savedItems?.[task.task_id];
    const recorded = saved && typeof saved === 'object'
      && Number.isInteger(saved.tab_id)
      && (saved.status === 'awaiting_manual_send' || saved.filled_at);
    if (!recorded) continue;
    if (recordedTabIds.has(saved.tab_id)) return sourceTasks;
    recordedTabIds.add(saved.tab_id);
  }
  return sourceTasks.filter((task) => {
    const saved = savedItems?.[task.task_id];
    if (!saved || typeof saved !== 'object' || !Number.isInteger(saved.tab_id)) return true;
    return saved.status !== 'awaiting_manual_send' && !saved.filled_at;
  });
}

function chatGPTProjectSlug(url) {
  const match = String(url ?? '').match(/^https:\/\/chatgpt\.com\/g\/([^/]+)\/(?:project|c\/[^/?#]+)\/?(?:[?#].*)?$/i);
  return match?.[1] ?? null;
}

function canonicalChatGPTProjectSlug(slug) {
  const projectId = String(slug).match(/^(g-p-[a-f0-9]{32})(?:-|$)/i);
  return (projectId?.[1] ?? slug).toLowerCase();
}

export function sameChatGPTProjectUrl(left, right) {
  const leftSlug = chatGPTProjectSlug(left);
  const rightSlug = chatGPTProjectSlug(right);
  if (!leftSlug || !rightSlug) return false;
  return canonicalChatGPTProjectSlug(leftSlug) === canonicalChatGPTProjectSlug(rightSlug);
}

function preparedConversationIdentity(url) {
  const match = String(url ?? '').match(/^https:\/\/chatgpt\.com\/g\/([^/]+)\/c\/([^/?#]+)\/?$/i);
  if (!match) return null;
  return `${canonicalChatGPTProjectSlug(match[1])}/c/${match[2]}`;
}

function normalizePromptText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function savedPreparedItem(items, taskId) {
  const item = items?.[taskId];
  return item && typeof item === 'object' ? item : {};
}

export function recoverPreparedTabMapping(tasks, savedItems, candidateTabs) {
  const mapping = {};
  const recovered = [];
  const unresolved = [];
  const unusedTabs = new Map((candidateTabs ?? []).filter((tab) => Number.isInteger(tab?.id)).map((tab) => [tab.id, tab]));
  const pending = [];

  for (const task of tasks ?? []) {
    const taskConversation = preparedConversationIdentity(task.web_conversation_url);
    const savedConversation = preparedConversationIdentity(savedPreparedItem(savedItems, task.task_id).url);
    const conversation = taskConversation ?? savedConversation;
    const urlMatches = conversation
      ? [...unusedTabs.values()].filter((tab) => preparedConversationIdentity(tab.url) === conversation)
      : [];
    if (urlMatches.length === 1) {
      const tab = urlMatches[0];
      mapping[task.task_id] = tab.id;
      unusedTabs.delete(tab.id);
      recovered.push({ task_id: task.task_id, tab_id: tab.id, source: 'conversation_url' });
      continue;
    }
    pending.push({ task, urlAmbiguous: urlMatches.length > 1 });
  }

  for (const { task, urlAmbiguous } of pending) {
    if (urlAmbiguous) {
      unresolved.push({ task_id: task.task_id, reason: 'ambiguous_conversation_url' });
      continue;
    }
    const prompt = normalizePromptText(task.variable_prompt ?? task.prompt);
    if (!prompt) {
      unresolved.push({ task_id: task.task_id, reason: 'task_prompt_missing' });
      continue;
    }
    const promptMatches = [...unusedTabs.values()].filter((tab) => normalizePromptText(tab.promptText).includes(prompt));
    if (promptMatches.length !== 1) {
      unresolved.push({ task_id: task.task_id, reason: promptMatches.length > 1 ? 'ambiguous_prompt_match' : 'prompt_not_found' });
      continue;
    }
    const tab = promptMatches[0];
    mapping[task.task_id] = tab.id;
    unusedTabs.delete(tab.id);
    recovered.push({ task_id: task.task_id, tab_id: tab.id, source: 'prompt' });
  }

  return { mapping, recovered, unresolved };
}

export function validatePreparedConversationUrls(urls, { allowProjectHome = true } = {}) {
  const normalized = [];
  const seen = new Set();
  for (const url of urls) {
    const value = String(url ?? '');
    if (/^https:\/\/chatgpt\.com\/g\/[^/]+\/project\/?$/.test(value)) {
      if (!allowProjectHome) return { ok: false, reason: 'conversation_urls_not_ready', details: urls };
      normalized.push(null);
      continue;
    }
    const match = value.match(/^https:\/\/chatgpt\.com\/g\/[^/]+\/c\/[^/?#]+\/?$/);
    if (!match) return { ok: false, reason: 'conversation_urls_not_ready', details: urls };
    const conversation = match[0].replace(/\/$/, '');
    if (seen.has(conversation)) return { ok: false, reason: 'conversation_urls_not_unique', details: normalized.map((item) => item ?? value) };
    seen.add(conversation);
    normalized.push(conversation);
  }
  return { ok: true, urls: normalized };
}

export function validatePreparedComposer({ composerVisible, draft } = {}) {
  if (!composerVisible) return { ok: false, reason: 'composer_not_visible' };
  if (String(draft ?? '').trim()) return { ok: false, reason: 'composer_not_empty' };
  return { ok: true };
}
