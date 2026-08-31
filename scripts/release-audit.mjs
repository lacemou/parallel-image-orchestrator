import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Only these paths are copied into the source release. Generated batches,
// prompt fixtures, registry manifests, and private keys are intentionally out.
export const RELEASE_PATHS = [
  '.gitignore',
  'README.md',
  'package.json',
  'bridge',
  'extension',
  'native-host/launcher.c',
  'native-host/launcher-windows.cs',
  'native-host/parallel-image-native-host.exe',
  'native-host/com.yj.parallel_image_orchestrator.json.template',
  'scripts/create-batch-from-prompts.mjs',
  'scripts/build-native-host-windows.mjs',
  'scripts/install-native-host.mjs',
  'scripts/uninstall-native-host.mjs',
  'scripts/package-release.mjs',
  'scripts/release-audit.mjs',
  'skill',
  'src',
  'test',
  'docs/design/2026-08-29-parallel-image-orchestrator-design.md',
];

const IGNORED_WORKSPACE_NAMES = new Set(['.git', 'node_modules', 'release', '.DS_Store']);
const SYNTHETIC_PROJECT_IDS = new Set([
  'g-p-0123456789abcdef0123456789abcdef',
  'g-p-fedcba9876543210fedcba9876543210',
]);

const AUDIT_PATTERNS = [
  { rule: 'local_path', regex: /[A-Z]:\\\\Users\\\\[^\\\\\s"']+(?:\\\\[^\\\\\s"']*)*/g },
  { rule: 'private_key_block', regex: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/g },
  { rule: 'openai_key', regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { rule: 'google_api_key', regex: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { rule: 'github_token', regex: /\bgh[pousr]_[0-9A-Za-z]{20,}\b|\bgithub_pat_[0-9A-Za-z_]{20,}\b/g },
  { rule: 'slack_token', regex: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g },
  { rule: 'aws_access_key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: 'bearer_token', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
  { rule: 'local_path', regex: /(?:\/Users\/[^/\s"'`]+(?:\/[^/\s"'`]*)*|\/home\/[^/\s"'`]+(?:\/[^/\s"'`]*)*|[A-Z]:\\Users\\[^\\\s"'`]+(?:\\[^\\\s"'`]*)*)/g },
  { rule: 'email_address', regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { rule: 'chatgpt_project_url', regex: /https:\/\/chatgpt\.com\/g\/(g-p-[a-f0-9]{32})(?:-[a-z0-9-]+)?\/(?:project|c\/[^/?#\s"']+)/gi },
];

function normalizedRoot(root) {
  if (root instanceof URL) return fileURLToPath(root);
  return resolve(String(root));
}

function relativePath(root, absolutePath) {
  return relative(root, absolutePath).split(sep).join('/');
}

function lineNumber(text, index) {
  return text.slice(0, index).split('\n').length;
}

function printableText(buffer) {
  return Buffer.from(buffer)
    .toString('utf8')
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '\n');
}

function isLikelyBinary(buffer) {
  const sample = Buffer.from(buffer).subarray(0, 8192);
  if (sample.includes(0)) return true;
  let controlBytes = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) controlBytes += 1;
  }
  return sample.length > 0 && controlBytes / sample.length > 0.1;
}

function isSyntheticChatGPTMatch(match) {
  const projectId = String(match).match(/\/g\/(g-p-[a-f0-9]{32})/i)?.[1]?.toLowerCase();
  return projectId ? SYNTHETIC_PROJECT_IDS.has(projectId) : false;
}

export function scanText(text, file = '<memory>') {
  const source = String(text ?? '');
  const findings = [];
  for (const { rule, regex } of AUDIT_PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(source))) {
      if (rule === 'chatgpt_project_url' && isSyntheticChatGPTMatch(match[0])) continue;
      findings.push({ rule, file, line: lineNumber(source, match.index) });
      if (!regex.global) break;
    }
  }
  return findings;
}

const RELEASE_BINARY_FILES = new Set(['native-host/parallel-image-native-host.exe']);

async function readDirectoryEntries(directory) {
  return readdir(directory, { withFileTypes: true });
}

async function walk(directory, root, files, { includeHidden = false } = {}) {
  const entries = (await readDirectoryEntries(directory)).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (IGNORED_WORKSPACE_NAMES.has(entry.name)) continue;
    if (!includeHidden && entry.name === '.DS_Store') continue;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(absolutePath, root, files, { includeHidden });
    } else if (entry.isFile()) {
      files.push(relativePath(root, absolutePath));
    }
  }
}

async function addReleasePath(root, pathSpec, files) {
  const absolutePath = join(root, pathSpec);
  let info;
  try {
    info = await stat(absolutePath);
  } catch {
    return;
  }
  if (info.isDirectory()) {
    await walk(absolutePath, root, files);
  } else if (info.isFile() && basename(absolutePath) !== '.DS_Store') {
    files.push(pathSpec.split('/').join('/'));
  }
}

export async function collectReleaseFiles(root = PROJECT_ROOT) {
  const normalized = normalizedRoot(root);
  const files = [];
  for (const pathSpec of RELEASE_PATHS) await addReleasePath(normalized, pathSpec, files);
  return [...new Set(files)].sort();
}

export async function collectWorkspaceFiles(root = PROJECT_ROOT) {
  const normalized = normalizedRoot(root);
  const files = [];
  await walk(normalized, normalized, files);
  return files.sort();
}

export async function scanFiles(root, files, { allowBinaryFiles = new Set() } = {}) {
  const normalized = normalizedRoot(root);
  const findings = [];
  for (const file of files) {
    const absolutePath = join(normalized, file);
    let buffer;
    try {
      buffer = await readFile(absolutePath);
    } catch {
      findings.push({ rule: 'unreadable_file', file });
      continue;
    }
    if (isLikelyBinary(buffer)) {
      if (allowBinaryFiles.has(file)) findings.push(...scanText(printableText(buffer), file));
      else findings.push({ rule: 'binary_file_skipped', file });
      continue;
    }
    findings.push(...scanText(printableText(buffer), file));
  }
  return findings;
}

export async function auditRelease(root = PROJECT_ROOT) {
  const files = await collectReleaseFiles(root);
  const findings = await scanFiles(root, files, {
    allowBinaryFiles: RELEASE_BINARY_FILES,
  });
  return { files, findings };
}

export async function auditWorkspace(root = PROJECT_ROOT) {
  const files = await collectWorkspaceFiles(root);
  const findings = await scanFiles(root, files, { allowBinaryFiles: RELEASE_BINARY_FILES });
  const releaseFiles = new Set(await collectReleaseFiles(root));
  const excludedFiles = files.filter((file) => !releaseFiles.has(file));
  return { files, findings, excludedFiles };
}

function formatFindings(findings) {
  if (!findings.length) return 'none';
  return findings.map(({ rule, file, line }) => `${rule} at ${file}:${line}`).join('\n');
}

function countByRule(findings) {
  return findings.reduce((counts, finding) => {
    counts[finding.rule] = (counts[finding.rule] || 0) + 1;
    return counts;
  }, {});
}

async function main() {
  const workspace = await auditWorkspace(PROJECT_ROOT);
  const release = await auditRelease(PROJECT_ROOT);
  const localArtifacts = workspace.findings.filter(({ file }) => !release.files.includes(file));
  const verbose = process.argv.includes('--verbose');
  const result = {
    release_ready: release.findings.length === 0,
    release_files: release.files.length,
    release_findings: release.findings,
    workspace_file_count: workspace.files.length,
    workspace_findings: workspace.findings.length,
    workspace_findings_by_rule: countByRule(workspace.findings),
    excluded_file_count: workspace.excludedFiles.length,
    excluded_local_findings: verbose ? localArtifacts : {
      count: localArtifacts.length,
      by_rule: countByRule(localArtifacts),
    },
  };
  console.log(JSON.stringify(result, null, 2));
  if (release.findings.length) {
    console.error(`Release audit failed:\n${formatFindings(release.findings)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
