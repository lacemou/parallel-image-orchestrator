import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePreflight } from '../src/preflight.js';

const ready = { userConfirmedLogin: true, projectUrl: 'https://chatgpt.com/g/example/project', composerVisible: true, fileInputVisible: true };

test('accepts a confirmed ChatGPT Project with a visible composer', () => {
  assert.deepEqual(validatePreflight(ready), { ok: true, reason: null });
});

test('fails closed when login is not confirmed', () => {
  assert.equal(validatePreflight({ ...ready, userConfirmedLogin: false }).ok, false);
});

test('fails closed outside a ChatGPT Project or without composer', () => {
  assert.equal(validatePreflight({ ...ready, projectUrl: 'https://chatgpt.com/' }).ok, false);
  assert.equal(validatePreflight({ ...ready, composerVisible: false }).ok, false);
});
