import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { createBatch } from './manifest.js';

const numberedFilePattern = /^(\d+)\.md$/i;
const numberedHeadingPattern = /^(#{1,6})[ \t]+(\d+)(?:[ \t]*(?:[-_:：][ \t]*.*)?)?[ \t]*$/gm;

function normalizePrompt(value, emptyReason) {
  const prompt = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (!prompt) throw new Error(emptyReason);
  return prompt;
}

function promptHash(prompt) {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

function taskFromPrompt({ taskId, prompt, filePath, section }) {
  const normalizedPrompt = normalizePrompt(prompt, section ? 'prompt_section_empty' : 'prompt_file_empty');
  const prompt_source = {
    kind: 'markdown_file',
    path: resolve(filePath),
    sha256: promptHash(normalizedPrompt),
    ...(section ? { section } : {}),
  };
  return {
    task_id: taskId,
    basename: `image_${taskId}`,
    variable_prompt: normalizedPrompt,
    prompt_source,
  };
}

async function readMarkdown(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw new Error('prompt_source_missing');
    throw error;
  }
}

function parseNumberedSections(filePath, text) {
  const matches = [...text.matchAll(numberedHeadingPattern)];
  if (!matches.length) throw new Error('prompt_source_format_ambiguous');
  const seen = new Set();
  return matches.map((match, index) => {
    const taskId = match[2];
    if (seen.has(taskId)) throw new Error('prompt_task_id_duplicate');
    seen.add(taskId);
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    return taskFromPrompt({ taskId, prompt: text.slice(start, end), filePath, section: taskId });
  });
}

async function loadNumberedFile(filePath, taskId) {
  const text = await readMarkdown(filePath);
  return taskFromPrompt({ taskId, prompt: text, filePath });
}

async function loadFromFile(filePath) {
  const fileName = basename(filePath);
  const numericMatch = fileName.match(numberedFilePattern);
  const text = await readMarkdown(filePath);
  if (numericMatch) return [taskFromPrompt({ taskId: numericMatch[1], prompt: text, filePath })];
  return parseNumberedSections(filePath, text);
}

async function loadFromDirectory(directoryPath) {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw new Error('prompt_source_missing');
    throw error;
  }
  const markdownFiles = entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.md')
    .map((entry) => ({ name: entry.name, path: join(directoryPath, entry.name) }));
  const numberedFiles = markdownFiles
    .map((file) => ({ ...file, match: file.name.match(numberedFilePattern) }))
    .filter((file) => file.match)
    .sort((left, right) => left.match[1].localeCompare(right.match[1], undefined, { numeric: true }) || left.match[1].localeCompare(right.match[1]));
  if (numberedFiles.length) {
    const seen = new Set();
    return Promise.all(numberedFiles.map(async (file) => {
      const taskId = file.match[1];
      if (seen.has(taskId)) throw new Error('prompt_task_id_duplicate');
      seen.add(taskId);
      return loadNumberedFile(file.path, taskId);
    }));
  }
  if (markdownFiles.length !== 1) throw new Error('prompt_source_format_ambiguous');
  return loadFromFile(markdownFiles[0].path);
}

export async function loadMarkdownPromptTasks(sourcePath) {
  if (!sourcePath || typeof sourcePath !== 'string') throw new Error('prompt_source_missing');
  const resolved = resolve(sourcePath);
  let sourceStats;
  try {
    sourceStats = await stat(resolved);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw new Error('prompt_source_missing');
    throw error;
  }
  if (sourceStats.isDirectory()) return loadFromDirectory(resolved);
  if (sourceStats.isFile() && extname(resolved).toLowerCase() === '.md') return loadFromFile(resolved);
  throw new Error('prompt_source_not_markdown');
}

export async function createBatchFromPromptDirectory(root, sourcePath) {
  if (!root || typeof root !== 'string') throw new Error('batch_root_missing');
  const tasks = await loadMarkdownPromptTasks(sourcePath);
  if (!tasks.length) throw new Error('prompt_source_empty');
  return createBatch(root, tasks);
}
