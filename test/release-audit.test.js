import test from 'node:test';
import assert from 'node:assert/strict';
import { scanText, collectReleaseFiles } from '../scripts/release-audit.mjs';
import { archiveName, checksumName, releaseManifestName, releaseName } from '../scripts/package-release.mjs';

const projectRoot = new URL('..', import.meta.url);

test('finds credential-shaped values without returning their contents', () => {
  const fakeKey = ['sk-proj-', '123456789012345678901234567890'].join('');
  const findings = scanText(`const apiKey = "${fakeKey}";`, 'src/example.js');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'openai_key');
  assert.equal(findings[0].file, 'src/example.js');
  assert.equal('snippet' in findings[0], false);
});

test('flags personal paths and real Project URLs while allowing synthetic fixtures', () => {
  const personalPath = ['/Users', 'example/private-project'].join('/');
  const realProjectUrl = ['https://chatgpt.com/g/g-p-', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/project'].join('');
  const syntheticProjectUrl = ['https://chatgpt.com/g/g-p-', '0123456789abcdef0123456789abcdef/project'].join('');
  const findings = scanText([
    `path=${personalPath}`,
    `url=${realProjectUrl}`,
    `fixture=${syntheticProjectUrl}`,
  ].join('\n'), 'fixture.txt');
  assert.deepEqual(findings.map(({ rule }) => rule), ['local_path', 'chatgpt_project_url']);
  assert.equal(findings.every((finding) => !('snippet' in finding)), true);
});

test('flags Windows paths escaped inside JSON text', () => {
  const findings = scanText('{"path":"C:\\\\Users\\\\example\\\\private-project"}', 'fixture.json');
  assert.deepEqual(findings.map(({ rule }) => rule), ['local_path']);
});

test('release file list includes the portable Windows host inputs and excludes machine-local state', async () => {
  const files = await collectReleaseFiles(projectRoot);
  assert.ok(files.includes('extension/options.css'));
  assert.ok(files.includes('native-host/launcher.c'));
  assert.ok(files.includes('native-host/launcher-windows.cs'));
  assert.ok(files.includes('native-host/parallel-image-native-host.exe'));
  assert.ok(files.includes('scripts/build-native-host-windows.mjs'));
  assert.ok(files.includes('scripts/uninstall-native-host.mjs'));
  assert.equal(files.includes('native-host/com.yj.parallel_image_orchestrator.json'), false);
  assert.equal(files.some((file) => file.startsWith('图片批次_')), false);
  assert.equal(files.some((file) => file.startsWith('提示词_')), false);
  assert.equal(files.some((file) => file.startsWith('docs/superpowers/')), false);
});

test('derives deterministic release names from the extension version', () => {
  assert.equal(releaseName('0.2.4'), 'parallel-image-orchestrator-v0.2.4');
  assert.equal(archiveName('0.2.4'), 'parallel-image-orchestrator-v0.2.4-source.zip');
  assert.equal(releaseManifestName('0.2.4'), 'parallel-image-orchestrator-v0.2.4-source.manifest.json');
  assert.equal(checksumName('0.2.4'), 'parallel-image-orchestrator-v0.2.4-source.zip.sha256');
});
