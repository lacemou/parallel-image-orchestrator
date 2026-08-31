import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  buildNativeHostManifest,
  buildNativeHostPlan,
  buildRegistryAddArgs,
  buildRegistryDeleteArgs,
  extensionIdFromPublicKey,
  isValidExtensionId,
} from '../src/native-host-install.js';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOST_NAME = 'com.yj.parallel_image_orchestrator';

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function nodeCandidates({ platformName = process.platform, processPath = process.execPath, environment = process.env } = {}) {
  if (platformName !== 'win32') return [processPath, environment.PIO_NODE_PATH, 'node'];
  return [
    environment.PIO_NODE_PATH,
    processPath,
    join(environment.ProgramW6432 || 'C:\\Program Files', 'nodejs', 'node.exe'),
    join(environment['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
    'node.exe',
  ].filter(Boolean);
}

export async function findNodeExecutable({ platformName = process.platform, processPath = process.execPath, environment = process.env, commandRunner = spawnSync } = {}) {
  for (const candidate of nodeCandidates({ platformName, processPath, environment })) {
    if (candidate === 'node' || candidate === 'node.exe') {
      const lookup = commandRunner(platformName === 'win32' ? 'where.exe' : 'which', [candidate], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (lookup.status === 0) return (lookup.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || candidate;
      continue;
    }
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

export async function validateExtensionIdAgainstManifest(projectRoot, extensionId) {
  const manifestPath = join(projectRoot, 'extension', 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error('extension_manifest_invalid');
  }
  if (!manifest.key) return { checked: false, extensionId };
  const expectedExtensionId = extensionIdFromPublicKey(manifest.key);
  if (expectedExtensionId !== extensionId) throw new Error(`extension_id_mismatch:${expectedExtensionId}`);
  return { checked: true, extensionId, expectedExtensionId };
}

export async function inspectNativeHostPlan(plan, { registryRunner = spawnSync, environment = process.env, checkRegistry = true } = {}) {
  const issues = [];
  if (!(await fileExists(plan.runnerPath))) issues.push('native_host_executable_missing');
  if (!(await fileExists(plan.bridgePath))) issues.push('bridge_missing');
  const nodeExecutable = await findNodeExecutable({ platformName: plan.platformName, environment });
  if (!nodeExecutable) issues.push('node_runtime_missing');

  let registryOutput = '';
  if (plan.platformName === 'win32' && checkRegistry) {
    const query = registryRunner('reg.exe', ['QUERY', plan.registryKey, '/ve'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    registryOutput = `${query.stdout || ''}\n${query.stderr || ''}`;
    if (query.status !== 0) issues.push('native_host_registry_missing');
    else if (!registryOutput.toLowerCase().includes(plan.manifestPath.toLowerCase())) issues.push('native_host_registry_mismatch');
  }

  let manifest = null;
  if (await fileExists(plan.manifestPath)) {
    try {
      manifest = JSON.parse(await readFile(plan.manifestPath, 'utf8'));
      if (manifest?.name !== plan.hostName) issues.push('native_host_manifest_name_mismatch');
      if (resolve(String(manifest?.path || '')) !== resolve(plan.runnerPath)) issues.push('native_host_manifest_path_mismatch');
      if (!Array.isArray(manifest?.allowed_origins) || !manifest.allowed_origins.includes(`chrome-extension://${plan.extensionId}/`)) {
        issues.push('native_host_manifest_origin_mismatch');
      }
    } catch {
      issues.push('native_host_manifest_invalid');
    }
  } else {
    issues.push('native_host_manifest_missing');
  }

  return { ok: issues.length === 0, issues, manifest, registryOutput, nodeExecutable };
}

function runRegistry(args, registryRunner = spawnSync) {
  const result = registryRunner('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw new Error(`registry_command_failed:${result.error.message}`);
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || '').trim();
    throw new Error(`registry_command_failed:${details || `exit_${result.status}`}`);
  }
  return result;
}

export async function installWindowsNativeHost(plan, { dryRun = false, registryRunner = spawnSync } = {}) {
  if (plan.platformName !== 'win32') throw new Error('windows_native_host_required');
  const before = await inspectNativeHostPlan(plan, { registryRunner, checkRegistry: false });
  const missing = before.issues.filter((issue) => !issue.startsWith('native_host_registry_') && !issue.startsWith('native_host_manifest_'));
  if (missing.length) throw new Error(`native_host_prerequisite_failed:${missing.join(',')}`);
  const manifest = buildNativeHostManifest(plan);
  const registryArgs = buildRegistryAddArgs(plan);
  if (dryRun) return { dryRun: true, plan, manifest, registryArgs };

  await mkdir(dirname(plan.manifestPath), { recursive: true });
  try {
    await writeFile(plan.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    if (before.nodeExecutable && plan.nodePathFile) await writeFile(plan.nodePathFile, `${before.nodeExecutable}\n`, 'utf8');
    runRegistry(registryArgs, registryRunner);
  } catch (error) {
    await rm(plan.manifestPath, { force: true });
    if (plan.nodePathFile) await rm(plan.nodePathFile, { force: true });
    throw error;
  }
  return { installed: true, plan, manifest, registryArgs };
}

function buildMacNativeHost(plan, { commandRunner = spawnSync } = {}) {
  const source = join(plan.projectRoot, 'native-host', 'launcher.c');
  const quoteDefine = (name, value) => `-D${name}=${JSON.stringify(value)}`;
  const result = commandRunner('clang', [
    '-O2', '-Wall', '-Wextra', '-o', plan.runnerPath, source,
    quoteDefine('NODE_PATH', process.execPath),
    quoteDefine('HOST_PATH', plan.bridgePath),
  ], { encoding: 'utf8' });
  if (result.error) throw new Error(`native_launcher_build_failed:${result.error.message}`);
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || '').trim();
    throw new Error(`native_launcher_build_failed:${details || `exit_${result.status}`}`);
  }
  const sign = commandRunner('codesign', ['--force', '--sign', '-', plan.runnerPath], { encoding: 'utf8' });
  if (sign.error) throw new Error(`native_launcher_sign_failed:${sign.error.message}`);
  if (sign.status !== 0) throw new Error('native_launcher_sign_failed');
}

export async function installMacNativeHost(plan, { dryRun = false, commandRunner = spawnSync } = {}) {
  if (plan.platformName !== 'darwin') throw new Error('mac_native_host_required');
  if (!(await fileExists(plan.bridgePath))) throw new Error('bridge_missing');
  const manifest = buildNativeHostManifest(plan);
  if (!dryRun) {
    await mkdir(dirname(plan.runnerPath), { recursive: true });
    buildMacNativeHost(plan, { commandRunner });
    await mkdir(dirname(plan.manifestPath), { recursive: true });
    await writeFile(plan.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return { installed: !dryRun, dryRun, plan, manifest };
}

export async function uninstallWindowsNativeHost(plan, { dryRun = false, registryRunner = spawnSync } = {}) {
  if (plan.platformName !== 'win32') throw new Error('windows_native_host_required');
  const current = await inspectNativeHostPlan(plan, { registryRunner });
  const ownershipIssues = current.issues.filter((issue) => issue === 'native_host_registry_mismatch' || issue.startsWith('native_host_manifest_'));
  if (ownershipIssues.length && !ownershipIssues.every((issue) => issue === 'native_host_manifest_missing' || issue === 'native_host_registry_missing')) {
    throw new Error(`native_host_ownership_check_failed:${ownershipIssues.join(',')}`);
  }
  const registryArgs = buildRegistryDeleteArgs(plan);
  if (dryRun) return { dryRun: true, plan, registryArgs };
  if (!current.issues.includes('native_host_registry_missing')) runRegistry(registryArgs, registryRunner);
  if (await fileExists(plan.manifestPath)) await rm(plan.manifestPath, { force: true });
  if (plan.nodePathFile && await fileExists(plan.nodePathFile)) await rm(plan.nodePathFile, { force: true });
  return { uninstalled: true, plan, registryArgs };
}

function parseArgs(argv) {
  const [extensionId, ...rest] = argv;
  if (!isValidExtensionId(extensionId)) throw new Error('usage: node scripts/install-native-host.mjs <32-char-extension-id> [--install|--check|--dry-run]');
  const options = { extensionId, mode: 'plan', dryRun: false };
  for (const argument of rest) {
    if (argument === '--install') options.mode = 'install';
    else if (argument === '--check') options.mode = 'check';
    else if (argument === '--dry-run') options.dryRun = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
}

export async function runCli({ argv = process.argv.slice(2), platformName = process.platform, projectRoot = PROJECT_ROOT } = {}) {
  const options = parseArgs(argv);
  await validateExtensionIdAgainstManifest(projectRoot, options.extensionId);
  const plan = buildNativeHostPlan({ platformName, projectRoot, extensionId: options.extensionId });
  if (options.mode === 'plan') return { install: false, plan, manifest: buildNativeHostManifest(plan) };
  if (options.mode === 'install') {
    if (platformName === 'win32') return installWindowsNativeHost(plan, { dryRun: options.dryRun });
    if (platformName === 'darwin') return installMacNativeHost(plan, { dryRun: options.dryRun });
    throw new Error(`native_host_platform_not_implemented:${platformName}`);
  }
  return inspectNativeHostPlan(plan);
}

async function main() {
  try {
    const result = await runCli();
    console.log(JSON.stringify(result, null, 2));
    if (process.argv.includes('--check') && result?.ok === false) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();
