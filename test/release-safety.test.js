import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('keeps ChatGPT URL fixtures synthetic instead of embedding a readable Project identity', async () => {
  const source = await readFile(new URL('./prepared-tabs.test.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /g-p-[a-f0-9]{32}-xiao-hong-shu-tu-zu-wang-ye-ban/i);
  assert.doesNotMatch(source, /c\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
});
