import { access, mkdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCE = join(PROJECT_ROOT, 'native-host', 'launcher-windows.cs');
const DEFAULT_OUTPUT = join(PROJECT_ROOT, 'native-host', 'parallel-image-native-host.exe');

function compilerCandidates() {
  return [
    process.env.PIO_CSC_PATH,
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', '18', 'BuildTools', 'MSBuild', 'Current', 'Bin', 'Roslyn', 'csc.exe'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft Visual Studio', '18', 'BuildTools', 'MSBuild', 'Current', 'Bin', 'Roslyn', 'csc.exe'),
    join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].filter(Boolean);
}

async function existingFile(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function findCSharpCompiler({ compilerPath = process.env.PIO_CSC_PATH } = {}) {
  for (const candidate of [compilerPath, ...compilerCandidates()]) {
    if (candidate && await existingFile(candidate)) return resolve(candidate);
  }
  const where = spawnSync('where.exe', ['csc.exe'], { encoding: 'utf8', windowsHide: true });
  const candidate = (where.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (candidate && await existingFile(candidate)) return resolve(candidate);
  throw new Error('native_host_compiler_not_found');
}

export async function buildNativeHostWindows({
  projectRoot = PROJECT_ROOT,
  sourcePath = join(projectRoot, 'native-host', 'launcher-windows.cs'),
  outputPath = join(projectRoot, 'native-host', 'parallel-image-native-host.exe'),
  compilerPath,
  runCommand = spawnSync,
} = {}) {
  const root = resolve(projectRoot);
  const source = resolve(sourcePath);
  const output = resolve(outputPath);
  if (!(await existingFile(source))) throw new Error('native_host_source_missing');
  const compiler = await findCSharpCompiler({ compilerPath });
  await mkdir(dirname(output), { recursive: true });
  const compilerArgs = [
    '/nologo',
    '/target:exe',
    '/optimize+',
    '/debug-',
    `/out:${output}`,
    source,
  ];
  if (compiler.toLowerCase().includes('\\roslyn\\')) compilerArgs.splice(4, 0, '/deterministic');
  const result = runCommand(compiler, compilerArgs, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.error) throw new Error(`native_host_build_failed:${result.error.message}`);
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || '').trim();
    throw new Error(`native_host_build_failed:${details || `exit_${result.status}`}`);
  }
  const outputStats = await stat(output).catch(() => null);
  if (!outputStats?.isFile() || outputStats.size === 0) throw new Error('native_host_output_missing');
  return { compiler, source, output, bytes: outputStats.size };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--source') options.sourcePath = argv[++index];
    else if (argument === '--output') options.outputPath = argv[++index];
    else if (argument === '--compiler') options.compilerPath = argv[++index];
    else if (argument === '--help' || argument === '-h') return { help: true };
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log('用法：node scripts/build-native-host-windows.mjs [--compiler <csc.exe>] [--source <launcher-windows.cs>] [--output <host.exe>]');
      return;
    }
    console.log(JSON.stringify(await buildNativeHostWindows(options), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();
