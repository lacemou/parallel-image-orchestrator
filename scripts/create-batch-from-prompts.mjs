#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { createBatchFromPromptDirectory } from '../src/prompt-files.js';

function usage() {
  return [
    '用法：node scripts/create-batch-from-prompts.mjs --prompt-dir <目录或 Markdown 文件> [--root <批次根目录>]',
    '',
    '--prompt-dir  每个任务的 Markdown 来源：001.md、002.md，或包含 ## 001 章节的单个 .md 文件。',
    '--root        图片批次_<id> 的存放位置；省略时使用当前工作目录。',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { root: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--prompt-dir') {
      options.promptDir = argv[++index];
      continue;
    }
    if (argument === '--root') {
      options.root = argv[++index];
      continue;
    }
    throw new Error(`unknown_argument:${argument}`);
  }
  if (!options.promptDir) throw new Error('prompt_dir_required');
  if (!options.root) throw new Error('batch_root_required');
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
  } else {
    const promptSource = resolve(options.promptDir);
    const batch = await createBatchFromPromptDirectory(resolve(options.root), promptSource);
    console.log(JSON.stringify({
      ok: true,
      path: batch.path,
      batch_id: batch.batch_id,
      batchPath: batch.path,
      extensionLoadPath: batch.path,
      archivePath: join(batch.path, '图片'),
      promptSource,
      taskCount: batch.tasks.length,
    }));
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }));
  process.exitCode = 1;
}
