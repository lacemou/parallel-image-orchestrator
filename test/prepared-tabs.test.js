import test from 'node:test';
import assert from 'node:assert/strict';
import { collectPreparedTabs, normalizePreparedTabError, pendingPreparedTasks, recoverPreparedTabMapping, reconcilePreparedTabs, sameChatGPTProjectUrl, validatePreparedComposer, validatePreparedConversationUrls } from '../extension/prepared-tabs.js';

test('converts a Chrome missing-tab exception into a stable recovery reason', () => {
  assert.deepEqual(normalizePreparedTabError(new Error('No tab with id: 296866897.')), {
    code: 'prepared_task_tab_missing',
    message: 'prepared_task_tab_missing',
  });
});

test('collects live prepared tabs and reports missing ones without throwing', async () => {
  const result = await collectPreparedTabs(
    [{ task_id: '002' }, { task_id: '004' }],
    { '002': 11, '004': 12 },
    async (tabId) => {
      if (tabId === 12) throw new Error('No tab with id: 12.');
      return { id: tabId, url: 'https://chatgpt.com/g/project/c/one' };
    },
  );
  assert.deepEqual(result.rows.map(({ task, tab }) => [task.task_id, tab.id]), [['002', 11]]);
  assert.deepEqual(result.missing, [{ task_id: '004', tab_id: 12, reason: 'prepared_task_tab_missing' }]);
});

test('does not let two tasks share one live prepared tab', async () => {
  const created = [];
  const result = await reconcilePreparedTabs(
    [{ task_id: '002' }, { task_id: '004' }],
    { '002': 11, '004': 11 },
    async (tabId) => ({ id: tabId, url: 'https://chatgpt.com/g/project/project' }),
    async (task) => {
      const tab = { id: 20 + created.length, url: 'https://chatgpt.com/g/project/project' };
      created.push(task.task_id);
      return tab;
    },
  );
  assert.deepEqual(created, ['004']);
  assert.deepEqual(result.mapping, { '002': 11, '004': 20 });
  assert.deepEqual(result.results.map(({ task_id, status }) => [task_id, status]), [['002', 'reused'], ['004', 'recreated']]);
});

test('reports a duplicate live tab mapping instead of returning the same tab twice', async () => {
  const result = await collectPreparedTabs(
    [{ task_id: '002' }, { task_id: '004' }],
    { '002': 11, '004': 11 },
    async (tabId) => ({ id: tabId, url: 'https://chatgpt.com/g/project/project' }),
  );
  assert.deepEqual(result.rows.map(({ task, tab }) => [task.task_id, tab.id]), [['002', 11]]);
  assert.deepEqual(result.missing, [{ task_id: '004', tab_id: 11, reason: 'prepared_task_tab_duplicate' }]);
});

test('reuses live prepared tabs and recreates only missing task pages', async () => {
  const created = [];
  const result = await reconcilePreparedTabs(
    [{ task_id: '002' }, { task_id: '004' }],
    { '002': 11, '004': 12 },
    async (tabId) => {
      if (tabId === 12) throw new Error('No tab with id: 12.');
      return { id: tabId, url: 'https://chatgpt.com/g/project/project' };
    },
    async (task) => {
      const tab = { id: 20 + created.length, url: 'https://chatgpt.com/g/project/project' };
      created.push(task.task_id);
      return tab;
    },
  );
  assert.deepEqual(created, ['004']);
  assert.deepEqual(result.mapping, { '002': 11, '004': 20 });
  assert.deepEqual(result.results.map(({ task_id, status }) => [task_id, status]), [['002', 'reused'], ['004', 'recreated']]);
});

test('recreates a live tab when it no longer belongs to the selected Project', async () => {
  const result = await reconcilePreparedTabs(
    [{ task_id: '002' }],
    { '002': 11 },
    async () => ({ id: 11, url: 'https://chatgpt.com/g/another-project/project' }),
    async () => ({ id: 21, url: 'https://chatgpt.com/g/project/project' }),
    (tab) => tab.url === 'https://chatgpt.com/g/project/project',
  );
  assert.deepEqual(result.mapping, { '002': 21 });
  assert.equal(result.results[0].status, 'recreated');
});

test('accepts the short and human-readable URL aliases of the same ChatGPT Project', () => {
  const shortProject = 'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/project';
  const readableProject = 'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-synthetic-project/project';
  const readableConversation = 'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-synthetic-project/c/conversation-synthetic-id';
  const otherProject = 'https://chatgpt.com/g/g-p-fedcba9876543210fedcba9876543210/project';

  assert.equal(sameChatGPTProjectUrl(shortProject, readableProject), true);
  assert.equal(sameChatGPTProjectUrl(readableConversation, shortProject), true);
  assert.equal(sameChatGPTProjectUrl(shortProject, otherProject), false);
});

test('rebinds a missing tab by its saved conversation URL', () => {
  const result = recoverPreparedTabMapping(
    [{ task_id: '002', variable_prompt: '提示词 2' }],
    { '002': { tab_id: 11, url: 'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-synthetic-project/c/conversation-2', status: 'awaiting_manual_send' } },
    [{ id: 21, url: 'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/c/conversation-2', promptText: '' }],
  );
  assert.deepEqual(result.mapping, { '002': 21 });
  assert.deepEqual(result.recovered, [{ task_id: '002', tab_id: 21, source: 'conversation_url' }]);
  assert.deepEqual(result.unresolved, []);
});

test('rebinds a missing tab from the task conversation URL when storage mapping is gone', () => {
  const result = recoverPreparedTabMapping(
    [{ task_id: '002', variable_prompt: '提示词 2', web_conversation_url: 'https://chatgpt.com/g/g-p-example/c/conversation-2' }],
    {},
    [{ id: 21, url: 'https://chatgpt.com/g/g-p-example/c/conversation-2', promptText: '' }],
  );
  assert.deepEqual(result.mapping, { '002': 21 });
  assert.deepEqual(result.recovered, [{ task_id: '002', tab_id: 21, source: 'conversation_url' }]);
  assert.deepEqual(result.unresolved, []);
});

test('rebinds a missing tab by a unique prompt and leaves ambiguous matches unresolved', () => {
  const result = recoverPreparedTabMapping(
    [
      { task_id: '002', variable_prompt: '提示词 2' },
      { task_id: '004', variable_prompt: '相同提示词' },
      { task_id: '006', variable_prompt: '相同提示词' },
    ],
    {},
    [
      { id: 21, url: 'https://chatgpt.com/g/g-p-abc/c/conversation-2', promptText: '用户：提示词 2' },
      { id: 22, url: 'https://chatgpt.com/g/g-p-abc/c/conversation-4', promptText: '用户：相同提示词' },
      { id: 23, url: 'https://chatgpt.com/g/g-p-abc/c/conversation-6', promptText: '用户：相同提示词' },
    ],
  );
  assert.deepEqual(result.mapping, { '002': 21 });
  assert.deepEqual(result.recovered, [{ task_id: '002', tab_id: 21, source: 'prompt' }]);
  assert.deepEqual(result.unresolved.map(({ task_id, reason }) => [task_id, reason]), [
    ['004', 'ambiguous_prompt_match'],
    ['006', 'ambiguous_prompt_match'],
  ]);
});

test('allows fresh Project home pages before send but rejects duplicate conversations', () => {
  assert.deepEqual(validatePreparedConversationUrls([
    'https://chatgpt.com/g/project/project',
    'https://chatgpt.com/g/project/project',
  ]), {
    ok: true,
    urls: [null, null],
  });
  assert.deepEqual(validatePreparedConversationUrls([
    'https://chatgpt.com/g/project/c/one',
    'https://chatgpt.com/g/project/c/two',
  ]), {
    ok: true,
    urls: ['https://chatgpt.com/g/project/c/one', 'https://chatgpt.com/g/project/c/two'],
  });
  assert.equal(validatePreparedConversationUrls([
    'https://chatgpt.com/g/project/c/one',
    'https://chatgpt.com/g/project/c/one',
  ]).reason, 'conversation_urls_not_unique');
  assert.equal(validatePreparedConversationUrls(['https://chatgpt.com/g/project/project'], { allowProjectHome: false }).reason, 'conversation_urls_not_ready');
});

test('requires every prepared composer to be visible and blank before filling', () => {
  assert.deepEqual(validatePreparedComposer({ composerVisible: true, draft: '' }), { ok: true });
  assert.deepEqual(validatePreparedComposer({ composerVisible: false, draft: '' }), { ok: false, reason: 'composer_not_visible' });
  assert.deepEqual(validatePreparedComposer({ composerVisible: true, draft: '旧提示词' }), { ok: false, reason: 'composer_not_empty' });
});

test('skips tasks already recorded as loaded when resuming a partial fill', () => {
  const tasks = [{ task_id: '002' }, { task_id: '004' }];
  const pending = pendingPreparedTasks(tasks, {
    '002': { tab_id: 11, status: 'awaiting_manual_send', filled_at: '2026-08-31T00:00:00.000Z' },
  });
  assert.deepEqual(pending, [{ task_id: '004' }]);
});

test('does not skip prepared tasks when their saved tab mappings collide', () => {
  const tasks = [{ task_id: '002' }, { task_id: '004' }];
  const pending = pendingPreparedTasks(tasks, {
    '002': { tab_id: 11, status: 'awaiting_manual_send', filled_at: '2026-08-31T00:00:00.000Z' },
    '004': { tab_id: 11, status: 'awaiting_manual_send', filled_at: '2026-08-31T00:00:00.000Z' },
  });
  assert.deepEqual(pending, tasks);
});

test('opens every missing task page without waiting for an earlier page to finish loading', async () => {
  const started = [];
  let releaseFirst;
  const firstCreated = new Promise((resolve) => { releaseFirst = resolve; });
  const run = reconcilePreparedTabs(
    [{ task_id: '002' }, { task_id: '004' }],
    {},
    async () => null,
    async (task) => {
      started.push(task.task_id);
      if (task.task_id === '002') return firstCreated;
      return { id: 24, url: 'https://chatgpt.com/g/project/project' };
    },
  );

  await Promise.resolve();
  assert.deepEqual(started, ['002', '004']);
  releaseFirst({ id: 22, url: 'https://chatgpt.com/g/project/project' });
  const result = await run;
  assert.deepEqual(result.results.map((item) => item.task_id), ['002', '004']);
});
