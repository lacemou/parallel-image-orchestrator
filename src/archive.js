import { copyFile, access } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { loadBatch, recordArchive } from './manifest.js';

function safeName(value) { return String(value || 'image').replace(/[^\p{L}\p{N}_-]+/gu, '_'); }

export async function archiveDownload(batchPath, { task_id, channel, sourcePath }) {
  const manifest = await loadBatch(batchPath);
  const task = manifest.tasks.find((item) => item.task_id === task_id);
  if (!task) throw new Error('unknown task');
  if (task.status !== 'completed') throw new Error('archive_requires_completed_task');
  const extension = extname(sourcePath) || '.png';
  let version = (task.artifacts ?? []).length + 1;
  let target;
  do {
    const filename = `${task_id}_${safeName(channel)}_${safeName(task.basename)}_v${String(version).padStart(2, '0')}${extension}`;
    target = join(batchPath, '图片', filename);
    try { await access(target); version += 1; } catch { break; }
  } while (true);
  await copyFile(sourcePath, target);
  await recordArchive(batchPath, task_id, { channel, path: target, source_path: sourcePath, version });
  return target;
}
