import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNativeComposerInputCommand, isPromptLoaded, waitForPromptLoaded } from '../extension/composer-input.js';

test('builds a CDP native text-input command for a focused composer', () => {
  assert.deepEqual(buildNativeComposerInputCommand('生成测试图'), {
    method: 'Input.insertText',
    params: { text: '生成测试图' },
  });
});

test('rejects an empty native composer input', () => {
  assert.throws(() => buildNativeComposerInputCommand(''), /prompt_empty/);
});

test('confirms a long prompt after normalizing composer line endings', () => {
  const prompt = `${'视觉约束\n'.repeat(1200)}输出约束：仅生成 1 张图片`;
  assert.equal(isPromptLoaded(prompt.replaceAll('\n', '\r\n'), prompt), true);
  assert.equal(isPromptLoaded('另一段提示词', prompt), false);
});

test('confirms a prompt when the browser normalizes whitespace and inserts invisible markers', () => {
  const prompt = '任务类型：正文配图。\n\n请生成一张白底编辑信息图。';
  const browserDraft = '任务类型：正文配图。\u00a0请生成一张白底编辑信息图。\u200b';
  assert.equal(isPromptLoaded(browserDraft, prompt), true);
});

test('waits for an asynchronously updated composer before declaring the prompt missing', async () => {
  const prompt = '第二个页面的提示词';
  const drafts = ['', '第二个页面', prompt];
  const result = await waitForPromptLoaded(
    async () => drafts.shift() ?? prompt,
    prompt,
    { timeoutMs: 100, intervalMs: 1 },
  );
  assert.deepEqual(result, { ok: true, status: 'prompt_loaded' });
});
