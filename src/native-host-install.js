import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, win32 } from 'node:path';

export const HOST_NAME = 'com.yj.parallel_image_orchestrator';
export const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const nativePath = { join, resolve };

function isWindowsPath(value) {
  return /^[A-Za-z]:(?:[\\/]|$)/.test(String(value ?? ''));
}

function pathApiForPlan(platformName, values) {
  if (platformName !== 'win32') return nativePath;
  return values.some(isWindowsPath) ? win32 : nativePath;
}

export function isValidExtensionId(value) {
  return EXTENSION_ID_PATTERN.test(String(value ?? ''));
}

export function extensionIdFromPublicKey(publicKey) {
  const key = Buffer.from(String(publicKey ?? ''), 'base64');
  if (!key.length) throw new Error('invalid_extension_public_key');
  const digest = createHash('sha256').update(key).digest().subarray(0, 16);
  return [...digest].flatMap((byte) => [(byte >> 4) & 0x0f, byte & 0x0f])
    .map((nibble) => String.fromCharCode(97 + nibble))
    .join('');
}

function assertExtensionId(extensionId) {
  if (!isValidExtensionId(extensionId)) throw new Error('invalid_extension_id');
  return extensionId;
}

function defaultManifestDirectory({ platformName, homeDirectory, localAppData, pathApi = nativePath }) {
  if (platformName === 'win32') {
    return pathApi.join(localAppData || pathApi.join(homeDirectory, 'AppData', 'Local'), 'Parallel Image Orchestrator', 'NativeMessagingHosts');
  }
  if (platformName === 'darwin') {
    return pathApi.join(homeDirectory, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
  }
  return pathApi.join(homeDirectory, '.config', 'google-chrome', 'NativeMessagingHosts');
}

export function buildNativeHostPlan({
  platformName = process.platform,
  projectRoot,
  extensionId,
  homeDirectory = homedir(),
  localAppData = process.env.LOCALAPPDATA,
  manifestDirectory,
} = {}) {
  if (!projectRoot) throw new Error('project_root_required');
  const normalizedExtensionId = assertExtensionId(extensionId);
  const pathApi = pathApiForPlan(platformName, [projectRoot, manifestDirectory, localAppData, homeDirectory]);
  const root = pathApi.resolve(String(projectRoot));
  const runnerName = platformName === 'win32' ? 'parallel-image-native-host.exe' : 'parallel-image-native-host';
  const manifestDir = pathApi.resolve(manifestDirectory || defaultManifestDirectory({ platformName, homeDirectory, localAppData, pathApi }));
  return {
    hostName: HOST_NAME,
    platformName,
    extensionId: normalizedExtensionId,
    projectRoot: root,
    runnerPath: pathApi.join(root, 'native-host', runnerName),
    bridgePath: pathApi.join(root, 'bridge', 'native-host.js'),
    manifestPath: pathApi.join(manifestDir, `${HOST_NAME}.json`),
    nodePathFile: platformName === 'win32' ? pathApi.join(manifestDir, 'node-path.txt') : null,
    registryKey: platformName === 'win32' ? `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}` : null,
  };
}

export function buildNativeHostManifest(plan) {
  return {
    name: plan.hostName,
    description: 'Parallel Image Orchestrator local bridge',
    path: plan.runnerPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${plan.extensionId}/`],
  };
}

function assertWindowsPlan(plan) {
  if (!plan?.registryKey || plan.platformName !== 'win32') throw new Error('windows_registry_plan_required');
}

export function buildRegistryAddArgs(plan) {
  assertWindowsPlan(plan);
  return ['ADD', plan.registryKey, '/ve', '/t', 'REG_SZ', '/d', plan.manifestPath, '/f'];
}

export function buildRegistryDeleteArgs(plan) {
  assertWindowsPlan(plan);
  return ['DELETE', plan.registryKey, '/f'];
}
