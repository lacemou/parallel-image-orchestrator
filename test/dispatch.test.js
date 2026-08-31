import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDispatchPlan } from '../src/dispatch.js';

test('creates a dispatch plan only after batch confirmation', () => {
  const result = buildDispatchPlan({ confirmed: true, allowedAttachments: ['portrait.png'], tasks: [{ task_id: '001', variable_prompt: 'cover', attachments: ['portrait.png'] }] });
  assert.equal(result.ok, true);
  assert.equal(result.tasks[0].attachments[0], 'portrait.png');
});

test('accepts a complete Markdown-derived prompt and preserves its source metadata', () => {
  const prompt = `${'视觉约束\n'.repeat(800)}只生成一张图`;
  const result = buildDispatchPlan({
    confirmed: true,
    tasks: [{ task_id: '002', prompt, prompt_source: { kind: 'markdown_file', path: 'prompts/002.md' } }],
  });
  assert.equal(result.tasks[0].variable_prompt, prompt);
  assert.deepEqual(result.tasks[0].prompt_source, { kind: 'markdown_file', path: 'prompts/002.md' });
});

test('requires an explicit attachment allowlist even after confirmation', () => {
  assert.equal(buildDispatchPlan({ confirmed: true, tasks: [{ task_id: '001', attachments: ['reference.png'] }] }).reason, 'attachment_not_allowlisted');
});

test('rejects unconfirmed batches and attachments outside the allowlist', () => {
  assert.equal(buildDispatchPlan({ confirmed: false, tasks: [] }).ok, false);
  assert.equal(buildDispatchPlan({ confirmed: true, allowedAttachments: [], tasks: [{ task_id: '001', attachments: ['secret.png'] }] }).ok, false);
});
