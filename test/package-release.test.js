import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZipArchive } from '../scripts/package-release.mjs';

test('creates a ZIP archive without requiring the Unix zip executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-package-'));
  const staging = join(root, 'staging');
  const packageDirectory = join(staging, 'parallel-image-orchestrator-v0.2.4');
  const archive = join(root, 'release.zip');
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, 'README.md'), 'release');

  await createZipArchive(staging, 'parallel-image-orchestrator-v0.2.4', archive);

  assert.ok((await stat(archive)).size > 0);
  assert.deepEqual((await readFile(archive)).subarray(0, 2), Buffer.from('PK'));
});
