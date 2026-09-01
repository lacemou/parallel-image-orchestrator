import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const skillPath = new URL('../skill/parallel-image-orchestrator/SKILL.md', import.meta.url);
const readmePath = new URL('../README.md', import.meta.url);

test('documents a separate local Codex start confirmation before web preflight', async () => {
  const skill = await readFile(skillPath, 'utf8');
  const startPrompt = '是否现在启动本地 Codex 生成任务';
  assert.match(skill, new RegExp(startPrompt));
  assert.match(skill, /分配确认后立即创建批次并返回/);
  assert.match(skill, /extensionLoadPath/);
  assert.match(skill, /每一张图片.*独立 Codex Desktop 对话/s);
  assert.match(skill, /不得使用.*子智能体/s);
  assert.match(skill, /网页端.*不得阻塞|网页.*不能阻塞/s);
  assert.ok(skill.indexOf(startPrompt) < skill.indexOf('Chrome Project preflight'));
});

test('README tells users that local Codex starts before web preparation', async () => {
  const readme = await readFile(readmePath, 'utf8');
  assert.match(readme, /先创建批次并返回路径/);
  assert.match(readme, /每一张.*独立 Codex Desktop 对话/s);
  assert.match(readme, /开始本地 Codex 生成/);
  assert.match(readme, /网页端.*不.*阻塞本地 Codex|本地 Codex.*不.*网页端/s);
});
