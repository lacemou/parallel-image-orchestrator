import test from 'node:test';
import assert from 'node:assert/strict';
import * as extensionMonitor from '../extension/web-monitor.js';
import {
  classifyWebResultObservation,
  createWebDownloadTracking,
  ensureSingleImagePrompt,
  normalizeObservedImage,
  normalizeConversationUrl,
  redactDownloadUrl,
  planWebMonitorAction,
  sameChatGPTConversationUrl,
} from '../src/web-monitor.js';

test('normalizes only a visible-sized image with a source URL', () => {
  assert.deepEqual(normalizeObservedImage({ src: 'blob:image-1', width: 1024, height: 1024 }), {
    src: 'blob:image-1',
    width: 1024,
    height: 1024,
  });
  assert.equal(normalizeObservedImage({ src: '', width: 1024, height: 1024 }), null);
  assert.equal(normalizeObservedImage({ src: 'blob:small', width: 32, height: 32 }), null);
});

test('ignores profile avatars and accepts explicitly generated image candidates', () => {
  assert.equal(normalizeObservedImage({
    src: 'https://chatgpt.com/avatar.png',
    width: 512,
    height: 512,
    alt: '个人资料图片',
  }), null);
  assert.deepEqual(normalizeObservedImage({
    src: 'https://chatgpt.com/generated.png',
    width: 1086,
    height: 1448,
    kind: 'generated',
  }), {
    src: 'https://chatgpt.com/generated.png',
    width: 1086,
    height: 1448,
  });
});

test('normalizes conversation URLs without query or hash noise', () => {
  assert.equal(normalizeConversationUrl('https://chatgpt.com/g/project/c/one/?oai-dm=1#result'), 'https://chatgpt.com/g/project/c/one');
});

test('redacts query and hash components from persisted download URL hints', () => {
  assert.equal(redactDownloadUrl('https://chatgpt.com/backend-api/estuary/content?id=file_1&sig=temporary#image'), 'https://chatgpt.com/backend-api/estuary/content');
  assert.equal(redactDownloadUrl('blob:image-1'), 'blob:');
  assert.equal(redactDownloadUrl(''), null);
});

test('classifies a running or not-yet-rendered conversation conservatively', () => {
  const base = {
    conversationUrl: 'https://chatgpt.com/g/g-p-example/c/one',
    expectedConversationUrl: 'https://chatgpt.com/g/g-p-example/c/one',
  };
  assert.deepEqual(classifyWebResultObservation({ ...base, generating: true, images: [], downloadControls: [] }), { status: 'running' });
  assert.deepEqual(classifyWebResultObservation({ ...base, generating: false, images: [], downloadControls: [] }), { status: 'waiting' });
  assert.equal(classifyWebResultObservation({ generating: false, images: [{ src: 'blob:image-1', width: 1024, height: 1024 }], downloadControls: [{}] }).status, 'wrong_conversation');
});

test('blocks wrong conversations and ambiguous image results', () => {
  assert.equal(classifyWebResultObservation({
    conversationUrl: 'https://chatgpt.com/g/g-p-example/c/wrong',
    expectedConversationUrl: 'https://chatgpt.com/g/g-p-example/c/one',
    generating: false,
    images: [{ src: 'blob:image-1', width: 1024, height: 1024 }],
    downloadControls: [{}],
  }).status, 'wrong_conversation');
  assert.deepEqual(classifyWebResultObservation({
    conversationUrl: 'https://chatgpt.com/g/g-p-example/c/one',
    expectedConversationUrl: 'https://chatgpt.com/g/g-p-example/c/one',
    generating: false,
    images: [
      { src: 'blob:image-1', width: 1024, height: 1024 },
      { src: 'blob:image-2', width: 1024, height: 1024 },
    ],
    downloadControls: [{}],
  }), { status: 'ambiguous_result', count: 2 });
});

test('accepts a redirected human-readable Project slug during observation', () => {
  assert.deepEqual(classifyWebResultObservation({
    conversationUrl: 'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-project-name/c/one',
    expectedConversationUrl: 'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/c/one',
    generating: false,
    images: [{ src: 'blob:image-1', width: 1024, height: 1024 }],
    downloadControls: [{ id: 'download-1' }],
  }), {
    status: 'ready',
    image: { src: 'blob:image-1', width: 1024, height: 1024 },
    downloadControl: { id: 'download-1' },
  });
});

test('accepts exactly one unique image only when exactly one download control exists', () => {
  const input = {
    conversationUrl: 'https://chatgpt.com/g/g-p-example/c/one',
    expectedConversationUrl: 'https://chatgpt.com/g/g-p-example/c/one',
    generating: false,
    images: [
      { src: 'blob:image-1', width: 1024, height: 1024 },
      { src: 'blob:image-1', width: 1024, height: 1024 },
    ],
  };
  assert.deepEqual(classifyWebResultObservation({ ...input, downloadControls: [] }), { status: 'download_unavailable', count: 0 });
  assert.deepEqual(classifyWebResultObservation({ ...input, downloadControls: [{ id: 'download-1' }] }), {
    status: 'ready',
    image: { src: 'blob:image-1', width: 1024, height: 1024 },
    downloadControl: { id: 'download-1' },
  });
  assert.deepEqual(classifyWebResultObservation({ ...input, downloadControls: [{ id: 'download-1' }, { id: 'download-2' }] }), { status: 'download_unavailable', count: 2 });
});

test('allows a direct signed image download when the current UI has no download control', () => {
  const observation = classifyWebResultObservation({
    conversationUrl: 'https://chatgpt.com/g/g-p-example/c/one',
    expectedConversationUrl: 'https://chatgpt.com/g/g-p-example/c/one',
    generating: false,
    images: [{ src: 'https://chatgpt.com/backend-api/estuary/content?id=file_1', width: 1086, height: 1448, kind: 'generated' }],
    downloadControls: [],
    directDownload: true,
  });
  assert.deepEqual(observation, {
    status: 'ready',
    image: { src: 'https://chatgpt.com/backend-api/estuary/content?id=file_1', width: 1086, height: 1448 },
    downloadControl: null,
    downloadMode: 'direct',
  });
  assert.deepEqual(planWebMonitorAction({ observation }), {
    status: 'request_download',
    image: observation.image,
    downloadControl: null,
    downloadMode: 'direct',
  });
});

test('does not count a page avatar alongside the generated image', () => {
  const result = classifyWebResultObservation({
    conversationUrl: 'https://chatgpt.com/g/g-p-example/c/one',
    expectedConversationUrl: 'https://chatgpt.com/g/g-p-example/c/one',
    generating: false,
    images: [
      { src: 'https://chatgpt.com/avatar.png', width: 512, height: 512, alt: '个人资料图片' },
      { src: 'https://chatgpt.com/backend-api/estuary/content?id=file_1', width: 1086, height: 1448, kind: 'generated' },
    ],
    downloadControls: [],
    directDownload: true,
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.image.src, 'https://chatgpt.com/backend-api/estuary/content?id=file_1');
});

test('does not request a second download while the first one is in flight', () => {
  const observation = {
    status: 'ready',
    image: { src: 'blob:image-1', width: 1024, height: 1024 },
    downloadControl: { id: 'download-1' },
  };
  assert.deepEqual(planWebMonitorAction({ observation }), {
    status: 'request_download',
    image: observation.image,
    downloadControl: observation.downloadControl,
  });
  assert.deepEqual(planWebMonitorAction({ observation, downloadRequested: true }), { status: 'download_pending' });
});

test('adds a single-image output guard once without duplicating an existing guard', () => {
  const guarded = ensureSingleImagePrompt('Draw a clean cover illustration.');
  assert.match(guarded, /仅生成 1 张图片/);
  assert.equal(ensureSingleImagePrompt(guarded), guarded);
  assert.equal(ensureSingleImagePrompt('只生成一张图片：蓝色纸飞机'), '只生成一张图片：蓝色纸飞机');
});

test('builds download association only for a confirmed web task tab', () => {
  assert.deepEqual(createWebDownloadTracking({
    batchPath: '/tmp/图片批次_demo',
    task_id: '002',
    tabId: 42,
    conversationUrl: 'https://chatgpt.com/g/g-p-example/c/one/',
    sourceUrl: 'blob:image-1',
  }), {
    batchPath: '/tmp/图片批次_demo',
    task_id: '002',
    channel: 'web',
    tabId: 42,
    conversationUrl: 'https://chatgpt.com/g/g-p-example/c/one',
    sourceUrl: 'blob:image-1',
  });
  assert.equal(createWebDownloadTracking({ batchPath: '/tmp/batch', task_id: '002', tabId: 42 }), null);
  assert.equal(createWebDownloadTracking({ batchPath: '/tmp/batch', task_id: '002', tabId: null, conversationUrl: 'https://chatgpt.com/g/p/c/one' }), null);
});

test('treats short and human-readable Project slugs as the same conversation identity', () => {
  assert.equal(sameChatGPTConversationUrl(
    'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/c/one',
    'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-project-name/c/one/?oai-dm=1',
  ), true);
  assert.equal(sameChatGPTConversationUrl(
    'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/c/one',
    'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-project-name/c/two',
  ), false);
});

test('ships the same monitor primitives inside the Chrome extension bundle', () => {
  assert.equal(typeof extensionMonitor.classifyWebResultObservation, 'function');
  assert.equal(extensionMonitor.normalizeConversationUrl('https://chatgpt.com/g/project/c/one/'), 'https://chatgpt.com/g/project/c/one');
});
