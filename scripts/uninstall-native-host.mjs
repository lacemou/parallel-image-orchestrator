import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { PROJECT_ROOT, uninstallWindowsNativeHost } from './install-native-host.mjs';
import { buildNativeHostPlan, isValidExtensionId } from '../src/native-host-install.js';

function parseArgs(argv) {
  const [extensionId, ...rest] = argv;
  if (!isValidExtensionId(extensionId)) throw new Error('usage: node scripts/uninstall-native-host.mjs <32-char-extension-id> [--dry-run]');
  const dryRun = rest.every((argument) => argument === '--dry-run');
  if (!dryRun && rest.length) throw new Error(`unknown_argument:${rest[0]}`);
  return { extensionId, dryRun };
}

async function main() {
  try {
    const { extensionId, dryRun } = parseArgs(process.argv.slice(2));
    const plan = buildNativeHostPlan({ platformName: process.platform, projectRoot: PROJECT_ROOT, extensionId });
    console.log(JSON.stringify(await uninstallWindowsNativeHost(plan, { dryRun }), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();
