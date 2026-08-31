import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const optionsHtmlPath = new URL('../extension/options.html', import.meta.url);
const optionsJsPath = new URL('../extension/options.js', import.meta.url);

test('explains exactly which path belongs in the extension', async () => {
  const html = await readFile(optionsHtmlPath, 'utf8');
  assert.match(html, /当前批次目录（包含 manifest\.json）/);
  assert.match(html, /extensionLoadPath/);
  assert.match(html, /提示词目录/);
  assert.match(html, /批次根目录/);
  assert.match(html, /图片.*子目录/);
});

test('maps a missing batch manifest to an actionable message', async () => {
  const source = await readFile(optionsJsPath, 'utf8');
  assert.match(source, /batch_manifest_missing/);
  assert.match(source, /包含 manifest\.json/);
});

test('exposes a scoped reset instead of a destructive memory wipe', async () => {
  const html = await readFile(optionsHtmlPath, 'utf8');
  const source = await readFile(optionsJsPath, 'utf8');
  assert.match(html, /重置当前批次网页准备（不删除图片\/对话）/);
  assert.match(html, /不会删除图片、ChatGPT 对话、登录状态或提示词文件/);
  assert.match(source, /pio\.batch\.reset_web_preparation/);
  assert.match(source, /旧任务页不会自动关闭/);
});

test('keeps newly opened task pages when their composer is not yet available', async () => {
  const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /chrome\.tabs\.remove\(tab\.id\)/);
});

test('fills the rendered composer and reports the task that stopped a batch', async () => {
  const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(source, /insertPromptWithDom/);
  assert.match(source, /Page\.bringToFront/);
  assert.match(source, /failed_task_id/);
});

test('renders task states as semantic status chips', async () => {
  const html = await readFile(optionsHtmlPath, 'utf8');
  const css = await readFile(new URL('../extension/options.css', import.meta.url), 'utf8');
  const source = await readFile(optionsJsPath, 'utf8');
  assert.match(html, /批次工作流/);
  assert.match(html, /<link rel="stylesheet" href="options\.css">/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(source, /statusChip/);
  assert.match(css, /\.status-chip/);
  assert.match(css, /\.status-blocked/);
  assert.match(css, /prefers-color-scheme: dark/);
  assert.doesNotMatch(html, /—|–/);
  assert.doesNotMatch(source, /—|–/);
});
