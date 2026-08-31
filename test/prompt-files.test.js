import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createBatchFromPromptDirectory, loadMarkdownPromptTasks } from '../src/prompt-files.js';

test('maps numbered Markdown files to task ids and ignores README.md', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-prompts-'));
  const promptDir = join(root, 'prompts');
  await mkdir(promptDir);
  await writeFile(join(promptDir, '001.md'), '第一张图的完整提示词\n');
  await writeFile(join(promptDir, '002.md'), '第二张图的完整提示词\r\n第二行');
  await writeFile(join(promptDir, 'README.md'), '# 说明文件\n');

  const tasks = await loadMarkdownPromptTasks(promptDir);

  assert.deepEqual(tasks.map((task) => task.task_id), ['001', '002']);
  assert.equal(tasks[0].variable_prompt, '第一张图的完整提示词');
  assert.equal(tasks[1].variable_prompt, '第二张图的完整提示词\n第二行');
  assert.deepEqual(tasks[0].prompt_source.kind, 'markdown_file');
  assert.equal(tasks[0].prompt_source.path, join(promptDir, '001.md'));
  assert.match(tasks[0].prompt_source.sha256, /^[a-f0-9]{64}$/);
});

test('maps numbered sections in one Markdown file to task ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-prompts-'));
  const promptDir = join(root, 'prompts');
  await mkdir(promptDir);
  const sourcePath = join(promptDir, 'prompts.md');
  await writeFile(sourcePath, '# 本批次\n\n## 001\n第一张提示词\n\n## 002 - 正文配图\n第二张提示词\n');

  const tasks = await loadMarkdownPromptTasks(promptDir);

  assert.deepEqual(tasks.map((task) => task.task_id), ['001', '002']);
  assert.equal(tasks[0].variable_prompt, '第一张提示词');
  assert.equal(tasks[1].variable_prompt, '第二张提示词');
  assert.deepEqual(tasks[1].prompt_source, {
    kind: 'markdown_file',
    path: sourcePath,
    section: '002',
    sha256: tasks[1].prompt_source.sha256,
  });
});

test('rejects an empty prompt section and an ambiguous prompt directory', async () => {
  const emptyRoot = await mkdtemp(join(tmpdir(), 'pio-prompts-'));
  const emptyDir = join(emptyRoot, 'prompts');
  await mkdir(emptyDir);
  await writeFile(join(emptyDir, 'prompts.md'), '## 001\n\n## 002\n有效提示词\n');
  await assert.rejects(() => loadMarkdownPromptTasks(emptyDir), /prompt_section_empty/);

  const ambiguousRoot = await mkdtemp(join(tmpdir(), 'pio-prompts-'));
  const ambiguousDir = join(ambiguousRoot, 'prompts');
  await mkdir(ambiguousDir);
  await writeFile(join(ambiguousDir, 'cover.md'), '封面提示词');
  await writeFile(join(ambiguousDir, 'body.md'), '正文提示词');
  await assert.rejects(() => loadMarkdownPromptTasks(ambiguousDir), /prompt_source_format_ambiguous/);
});

test('creates a batch from a user-selected prompt directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-prompts-'));
  const promptDir = join(root, 'prompts');
  const outputRoot = join(root, 'output');
  await mkdir(promptDir);
  await mkdir(outputRoot);
  await writeFile(join(promptDir, '001.md'), '封面提示词');
  await writeFile(join(promptDir, '002.md'), '正文提示词');
  await writeFile(join(promptDir, '003.md'), '卡片提示词');
  await writeFile(join(promptDir, '004.md'), '补充提示词');

  const batch = await createBatchFromPromptDirectory(outputRoot, promptDir);

  assert.equal(dirname(batch.path), outputRoot);
  assert.match(batch.path, /图片批次_/);
  assert.equal(batch.tasks[1].variable_prompt, '正文提示词');
  assert.match(batch.tasks[1].effective_prompt, /正文提示词/);
  assert.match(batch.tasks[1].effective_prompt, /仅生成 1 张图片/);
  assert.equal(batch.tasks[1].prompt_source.path, join(promptDir, '002.md'));
});
