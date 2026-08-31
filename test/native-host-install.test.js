import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import {
  buildNativeHostManifest,
  buildNativeHostPlan,
  buildRegistryAddArgs,
  buildRegistryDeleteArgs,
  extensionIdFromPublicKey,
  isValidExtensionId,
} from '../src/native-host-install.js';
import { findNodeExecutable, installWindowsNativeHost, uninstallWindowsNativeHost, validateExtensionIdAgainstManifest } from '../scripts/install-native-host.mjs';

test('validates Chrome extension IDs without accepting wildcard or malformed origins', () => {
  assert.equal(isValidExtensionId('a'.repeat(32)), true);
  assert.equal(isValidExtensionId('p'.repeat(32)), true);
  assert.equal(isValidExtensionId('z'.repeat(32)), false);
  assert.equal(isValidExtensionId('a'.repeat(31)), false);
  assert.equal(isValidExtensionId('a'.repeat(32) + '/'), false);
});

test('derives the stable Chrome extension ID from the manifest public key', async () => {
  const manifest = JSON.parse(await readFile(join('extension', 'manifest.json'), 'utf8'));
  assert.equal(extensionIdFromPublicKey(manifest.key), 'plmmdeknmoafiaeghnmengbdckcaidga');
  assert.deepEqual(await validateExtensionIdAgainstManifest('.', 'plmmdeknmoafiaeghnmengbdckcaidga'), {
    checked: true,
    extensionId: 'plmmdeknmoafiaeghnmengbdckcaidga',
    expectedExtensionId: 'plmmdeknmoafiaeghnmengbdckcaidga',
  });
  await assert.rejects(
    () => validateExtensionIdAgainstManifest('.', 'a'.repeat(32)),
    /extension_id_mismatch:plmmdeknmoafiaeghnmengbdckcaidga/,
  );
});

test('does not report a PATH Node runtime when the lookup command fails', async () => {
  const node = await findNodeExecutable({
    platformName: 'win32',
    processPath: 'Z:\\missing\\node.exe',
    environment: { ProgramW6432: 'Z:\\missing', 'ProgramFiles(x86)': 'Z:\\missing-x86' },
    commandRunner: () => ({ status: 1, stdout: '', stderr: '' }),
  });
  assert.equal(node, null);
});

test('builds a Windows per-user native-host installation plan', () => {
  const projectRoot = win32.join('C:\\', 'Users', 'example', 'parallel-image-orchestrator');
  const localAppData = win32.join('C:\\', 'Users', 'example', 'AppData', 'Local');
  const extensionId = 'a'.repeat(32);
  const plan = buildNativeHostPlan({
    platformName: 'win32',
    projectRoot,
    extensionId,
    localAppData,
  });

  assert.equal(plan.hostName, 'com.yj.parallel_image_orchestrator');
  assert.equal(plan.runnerPath, win32.join(projectRoot, 'native-host', 'parallel-image-native-host.exe'));
  assert.equal(plan.bridgePath, win32.join(projectRoot, 'bridge', 'native-host.js'));
  assert.equal(plan.manifestPath, win32.join(localAppData, 'Parallel Image Orchestrator', 'NativeMessagingHosts', 'com.yj.parallel_image_orchestrator.json'));
  assert.equal(plan.nodePathFile, win32.join(localAppData, 'Parallel Image Orchestrator', 'NativeMessagingHosts', 'node-path.txt'));
  assert.equal(plan.registryKey, 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.yj.parallel_image_orchestrator');

  assert.deepEqual(buildNativeHostManifest(plan), {
    name: 'com.yj.parallel_image_orchestrator',
    description: 'Parallel Image Orchestrator local bridge',
    path: plan.runnerPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  });
  assert.deepEqual(buildRegistryAddArgs(plan), [
    'ADD', plan.registryKey, '/ve', '/t', 'REG_SZ', '/d', plan.manifestPath, '/f',
  ]);
  assert.deepEqual(buildRegistryDeleteArgs(plan), [
    'DELETE', plan.registryKey, '/f',
  ]);
});

test('rejects an invalid extension ID before producing a host manifest', () => {
  assert.throws(
    () => buildNativeHostPlan({ platformName: 'win32', projectRoot: 'C:\\work', extensionId: 'not-an-id' }),
    /invalid_extension_id/,
  );
});

test('installs and uninstalls the generated manifest through an injectable registry command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pio-native-host-'));
  const nativeHostDirectory = join(root, 'native-host');
  const bridgeDirectory = join(root, 'bridge');
  const manifestDirectory = join(root, 'generated-manifest');
  await mkdir(nativeHostDirectory, { recursive: true });
  await mkdir(bridgeDirectory, { recursive: true });
  await writeFile(join(nativeHostDirectory, 'parallel-image-native-host.exe'), 'host');
  await writeFile(join(bridgeDirectory, 'native-host.js'), 'bridge');
  const plan = buildNativeHostPlan({
    platformName: 'win32',
    projectRoot: root,
    extensionId: 'b'.repeat(32),
    manifestDirectory,
  });
  const calls = [];
  const registryRunner = (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'QUERY') return { status: 0, stdout: plan.manifestPath, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };

  const installed = await installWindowsNativeHost(plan, { registryRunner });
  assert.equal(installed.installed, true);
  assert.deepEqual(JSON.parse(await readFile(plan.manifestPath, 'utf8')), buildNativeHostManifest(plan));
  assert.equal((await readFile(plan.nodePathFile, 'utf8')).trim(), process.execPath);
  assert.deepEqual(calls[0], { command: 'reg.exe', args: buildRegistryAddArgs(plan) });

  const uninstalled = await uninstallWindowsNativeHost(plan, { registryRunner });
  assert.equal(uninstalled.uninstalled, true);
  assert.deepEqual(calls[1], { command: 'reg.exe', args: ['QUERY', plan.registryKey, '/ve'] });
  assert.deepEqual(calls[2], { command: 'reg.exe', args: buildRegistryDeleteArgs(plan) });
});
