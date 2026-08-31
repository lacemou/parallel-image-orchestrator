import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { auditRelease } from './release-audit.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function normalizedRoot(root) {
  return root instanceof URL ? fileURLToPath(root) : resolve(String(root));
}

function checkedVersion(version) {
  const value = String(version ?? '').trim();
  if (!value || !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(value)) {
    throw new Error(`invalid_extension_version:${value || '<empty>'}`);
  }
  return value;
}

export function releaseName(version) {
  return `parallel-image-orchestrator-v${checkedVersion(version)}`;
}

export function archiveName(version) {
  return `${releaseName(version)}-source.zip`;
}

export function releaseManifestName(version) {
  return `${releaseName(version)}-source.manifest.json`;
}

export function checksumName(version) {
  return `${releaseName(version)}-source.zip.sha256`;
}

async function copyFiles(root, destination, files) {
  for (const file of files) {
    const source = join(root, file);
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { force: true });
  }
}

function sha256File(path) {
  return readFile(path).then((buffer) => createHash('sha256').update(buffer).digest('hex'));
}

export function createZipArchive(stagingDirectory, packageDirectoryName, archivePath) {
  const normalizedArchivePath = resolve(archivePath);
  const isWindows = process.platform === 'win32';
  const command = isWindows ? 'powershell.exe' : 'zip';
  const args = isWindows
    ? [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        '& { param([string] $source, [string] $destination); Compress-Archive -LiteralPath $source -DestinationPath $destination -Force }',
        join(stagingDirectory, packageDirectoryName),
        normalizedArchivePath,
      ]
    : ['-q', '-r', '-X', normalizedArchivePath, packageDirectoryName];
  const result = spawnSync(command, args, {
    cwd: stagingDirectory,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw new Error(`zip_unavailable:${result.error.message}`);
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || '').trim();
    throw new Error(`zip_failed:${details || `exit_${result.status}`}`);
  }
  return normalizedArchivePath;
}

export async function packageRelease(root = PROJECT_ROOT, outputDirectory) {
  const projectRoot = normalizedRoot(root);
  const outputDir = normalizedRoot(outputDirectory ?? join(projectRoot, 'release'));
  const manifest = JSON.parse(await readFile(join(projectRoot, 'extension', 'manifest.json'), 'utf8'));
  const version = checkedVersion(manifest.version);
  const { files, findings } = await auditRelease(projectRoot);
  if (findings.length) {
    const details = findings.map(({ rule, file, line }) => `${rule}@${file}:${line}`).join(',');
    throw new Error(`release_audit_failed:${details}`);
  }

  await mkdir(outputDir, { recursive: true });
  const stagingDirectory = await mkdtemp(join(outputDir, '.staging-'));
  const packageDirectoryName = releaseName(version);
  const packageDirectory = join(stagingDirectory, packageDirectoryName);
  const archivePath = join(outputDir, archiveName(version));
  try {
    await copyFiles(projectRoot, packageDirectory, files);
    await rm(archivePath, { force: true });
    createZipArchive(stagingDirectory, packageDirectoryName, archivePath);
    const sha256 = await sha256File(archivePath);
    const manifestPath = join(outputDir, releaseManifestName(version));
    const checksumPath = join(outputDir, checksumName(version));
    const nativeHostPath = join(projectRoot, 'native-host', 'parallel-image-native-host.exe');
    const nativeHostSha256 = await sha256File(nativeHostPath).catch(() => null);
    await writeFile(manifestPath, `${JSON.stringify({
      version,
      archive: basename(archivePath),
      archive_sha256: sha256,
      files,
      windows_native_host: nativeHostSha256 ? {
        path: 'native-host/parallel-image-native-host.exe',
        sha256: nativeHostSha256,
      } : null,
    }, null, 2)}\n`, 'utf8');
    await writeFile(checksumPath, `${sha256}  ${basename(archivePath)}\n`, 'utf8');
    return {
      version,
      files: files.length,
      archive: relative(projectRoot, archivePath).split(sep).join('/'),
      sha256,
      manifest: relative(projectRoot, manifestPath).split(sep).join('/'),
      checksum: relative(projectRoot, checksumPath).split(sep).join('/'),
      nativeHostSha256,
    };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function main() {
  try {
    console.log(JSON.stringify(await packageRelease(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
