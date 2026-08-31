import test from 'node:test';
import assert from 'node:assert/strict';
import { initialAssignments, nextAssignment } from '../src/scheduler.js';

test('assigns five queued tasks with a Codex tie-break', () => {
  const assigned = initialAssignments(['001', '002', '003', '004', '005']);
  assert.deepEqual(assigned.map((item) => item.channel), ['codex', 'web', 'codex', 'web', 'codex']);
});

test('gives the next queued task to the channel that freed a slot', () => {
  assert.deepEqual(nextAssignment(['011', '012'], 'web'), { task_id: '011', channel: 'web' });
});

test('caps the initial assignment at five tasks per channel', () => {
  const assigned = initialAssignments(Array.from({ length: 12 }, (_, i) => String(i + 1)));
  assert.equal(assigned.filter((item) => item.channel === 'codex').length, 5);
  assert.equal(assigned.filter((item) => item.channel === 'web').length, 5);
  assert.equal(assigned.filter((item) => item.channel === 'queued').length, 2);
});
