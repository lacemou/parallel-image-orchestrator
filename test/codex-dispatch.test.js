import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexTaskRequest, buildCodexArchiveCommand } from '../src/codex-dispatch.js';

test('builds an isolated Codex image-task request from one confirmed task', () => {
  const request = buildCodexTaskRequest({ task_id: '001', variable_prompt: 'blue cover', attachments: ['portrait.png'] });
  assert.equal(request.title, 'PIO 001');
  assert.match(request.prompt, /blue cover/);
  assert.match(request.prompt, /portrait\.png/);
  assert.match(request.prompt, /不修改项目文件/);
  assert.match(request.prompt, /savedPath/);
});

test('uses a complete prompt when a task came from a Markdown source field', () => {
  const request = buildCodexTaskRequest({ task_id: '002', prompt: 'long Markdown-derived prompt' });
  assert.match(request.prompt, /long Markdown-derived prompt/);
});

test('creates a confirmed archive command for a selected Codex result only', () => {
  assert.equal(buildCodexArchiveCommand({ confirmed: false, batchPath: '/tmp/batch', task_id: '001', sourcePath: '/tmp/image.png' }).ok, false);
  assert.deepEqual(buildCodexArchiveCommand({ confirmed: true, batchPath: '/tmp/batch', task_id: '001', sourcePath: '/tmp/image.png' }), {
    ok: true, type: 'archive_codex_image', confirmed: true, batchPath: '/tmp/batch', task_id: '001', channel: 'codex', sourcePath: '/tmp/image.png',
  });
});
