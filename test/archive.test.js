import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeTaskAndAssignNext, createBatch, loadBatch, transitionTask } from '../src/manifest.js';
import { archiveDownload } from '../src/archive.js';

test('archives a downloaded image with its task and channel in the filename', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await createBatch(root, [{ task_id: '001', basename: 'cover' }]);
  await transitionTask(batch.path, '001', 'dispatching');
  await transitionTask(batch.path, '001', 'generating');
  await transitionTask(batch.path, '001', 'completed');
  const source = join(root, 'download.png');
  await writeFile(source, 'image');
  const archived = await archiveDownload(batch.path, { task_id: '001', channel: 'web', sourcePath: source });
  await stat(archived);
  assert.equal(archived, join(batch.path, '图片', '001_web_cover_v01.png'));
  assert.equal((await loadBatch(batch.path)).tasks[0].status, 'archived');
});

test('releases the web slot before archiving the downloaded result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await createBatch(root, Array.from({ length: 11 }, (_, index) => ({ task_id: String(index + 1).padStart(3, '0'), basename: `image-${index + 1}` })));
  await transitionTask(batch.path, '002', 'dispatching');
  await transitionTask(batch.path, '002', 'generating');
  const completion = await completeTaskAndAssignNext(batch.path, '002', 'web', { conversation_url: 'https://chatgpt.com/g/project/c/two' });
  assert.equal(completion.completedTask.status, 'completed');
  assert.equal(completion.nextTask.task_id, '011');
  assert.equal(completion.nextTask.assigned_channel, 'web');
  assert.equal((await loadBatch(batch.path)).tasks.find((task) => task.task_id === '011').assigned_channel, 'web');

  const source = join(root, 'download.png');
  await writeFile(source, 'image');
  const archived = await archiveDownload(batch.path, { task_id: '002', channel: 'web', sourcePath: source });
  assert.equal(archived, join(batch.path, '图片', '002_web_image-2_v01.png'));
  assert.equal((await loadBatch(batch.path)).tasks.find((task) => task.task_id === '002').status, 'archived');
});

test('rejects archiving a task before completion without copying a stray file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-'));
  const batch = await createBatch(root, [{ task_id: '001', basename: 'cover' }]);
  await transitionTask(batch.path, '001', 'dispatching');
  await transitionTask(batch.path, '001', 'generating');
  const source = join(root, 'download.png');
  await writeFile(source, 'image');

  await assert.rejects(
    () => archiveDownload(batch.path, { task_id: '001', channel: 'codex', sourcePath: source }),
    /archive_requires_completed_task/,
  );
  assert.deepEqual(await readdir(join(batch.path, '图片')), []);
});
