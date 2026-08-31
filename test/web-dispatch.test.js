import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWebDispatchCommand } from '../src/web-dispatch.js';

test('creates a web dispatch command only after explicit confirmation', () => {
  assert.deepEqual(buildWebDispatchCommand({ confirmed: true, loginConfirmed: true, task_id: '001', prompt: 'draw a plane' }), { ok: true, type: 'pio.web.dispatch', confirmed: true, loginConfirmed: true, task_id: '001', prompt: 'draw a plane\n\n输出约束：仅生成 1 张图片；不要生成图片组、拼图、多张变体或候选。', attachments: [], allowedAttachments: [] });
});

test('blocks an unconfirmed web dispatch command', () => {
  assert.equal(buildWebDispatchCommand({ confirmed: false, loginConfirmed: true, task_id: '001', prompt: 'draw' }).ok, false);
  assert.equal(buildWebDispatchCommand({ confirmed: true, loginConfirmed: false, task_id: '001', prompt: 'draw' }).ok, false);
});

test('blocks a dispatch command with an empty prompt', () => {
  assert.equal(buildWebDispatchCommand({ confirmed: true, loginConfirmed: true, task_id: '001', prompt: '' }).ok, false);
});

test('blocks attachments outside the explicitly confirmed allowlist', () => {
  assert.equal(buildWebDispatchCommand({ confirmed: true, loginConfirmed: true, task_id: '001', prompt: 'draw', attachments: ['portrait.png'] }).reason, 'attachment_not_allowlisted');
});
