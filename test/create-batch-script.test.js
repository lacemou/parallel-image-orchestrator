import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('../scripts/create-batch-from-prompts.mjs', import.meta.url));

test('prints a copyable extension path when creating a batch from Markdown prompts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-cli-'));
  const promptDir = join(root, 'prompts');
  const outputRoot = join(root, 'output');
  await mkdir(promptDir);
  await mkdir(outputRoot);
  await writeFile(join(promptDir, '001.md'), '封面提示词');
  await writeFile(join(promptDir, '002.md'), '正文提示词');
  await writeFile(join(promptDir, '003.md'), '卡片提示词');
  await writeFile(join(promptDir, '004.md'), '补充提示词');

  const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--prompt-dir', promptDir, '--root', outputRoot]);
  const result = JSON.parse(stdout);

  assert.equal(result.ok, true);
  assert.equal(result.promptSource, promptDir);
  assert.equal(result.taskCount, 4);
  assert.equal(result.path, result.batchPath);
  assert.match(result.batch_id, /^[0-9a-f-]{36}$/);
  assert.equal(dirname(result.batchPath), outputRoot);
  assert.match(result.batchPath, /图片批次_/);
  assert.equal(result.extensionLoadPath, result.batchPath);
  assert.equal(result.archivePath, join(result.batchPath, '图片'));
});
