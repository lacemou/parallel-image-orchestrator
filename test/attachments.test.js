import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAttachmentUpload } from '../src/attachments.js';

test('creates a CDP attachment request only for confirmed allowlisted files', () => {
  const result = buildAttachmentUpload({ confirmed: true, projectUrl: 'https://chatgpt.com/g/project/project', allowedAttachments: ['/tmp/portrait.png'], files: ['/tmp/portrait.png'] });
  assert.deepEqual(result, { ok: true, files: ['/tmp/portrait.png'] });
});

test('blocks unconfirmed or non-allowlisted attachment requests', () => {
  assert.equal(buildAttachmentUpload({ confirmed: false, files: ['/tmp/a.png'] }).ok, false);
  assert.equal(buildAttachmentUpload({ confirmed: true, projectUrl: 'https://chatgpt.com/g/project/project', allowedAttachments: [], files: ['/tmp/a.png'] }).ok, false);
});
