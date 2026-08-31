export function normalizeConversationUrl(url) {
  const value = String(url ?? '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    parsed.search = '';
    parsed.hash = '';
    return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
  } catch {
    return value.replace(/\/$/, '');
  }
}

export function redactDownloadUrl(url) {
  const value = String(url ?? '').trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!/^https?:$/i.test(parsed.protocol)) return `${parsed.protocol}`;
    parsed.search = '';
    parsed.hash = '';
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function conversationIdentity(url) {
  const normalized = normalizeConversationUrl(url);
  const match = normalized.match(/^https:\/\/chatgpt\.com\/g\/([^/]+)\/c\/([^/]+)$/i);
  if (!match) return null;
  const project = match[1].match(/^(g-p-[a-f0-9]{32})(?:-|$)/i)?.[1] ?? match[1];
  return `${project.toLowerCase()}/c/${match[2]}`;
}

export function sameChatGPTConversationUrl(left, right) {
  const leftIdentity = conversationIdentity(left);
  const rightIdentity = conversationIdentity(right);
  return Boolean(leftIdentity && rightIdentity && leftIdentity === rightIdentity);
}

export function normalizeObservedImage(image) {
  const src = String(image?.src ?? '').trim();
  const width = Number(image?.width ?? 0);
  const height = Number(image?.height ?? 0);
  const kind = String(image?.kind ?? '').trim().toLowerCase();
  const alt = String(image?.alt ?? '').trim().toLowerCase();
  if (kind && kind !== 'generated') return null;
  if (!kind && (image?.ariaHidden === true || /(?:个人资料图片|profile picture|avatar)/i.test(alt))) return null;
  if (!src || !Number.isFinite(width) || !Number.isFinite(height) || width < 256 || height < 256) return null;
  return { src, width, height };
}

export function classifyWebResultObservation({ conversationUrl, expectedConversationUrl, generating, images = [], downloadControls = [], directDownload = false } = {}) {
  const normalizedConversationUrl = normalizeConversationUrl(conversationUrl);
  const normalizedExpectedConversationUrl = normalizeConversationUrl(expectedConversationUrl);
  const exactMatch = Boolean(normalizedConversationUrl && normalizedExpectedConversationUrl && normalizedConversationUrl === normalizedExpectedConversationUrl);
  if (!exactMatch && !sameChatGPTConversationUrl(conversationUrl, expectedConversationUrl)) return { status: 'wrong_conversation' };
  if (generating) return { status: 'running' };

  const uniqueImages = [...new Map(images.map(normalizeObservedImage).filter(Boolean).map((image) => [image.src, image])).values()];
  if (!uniqueImages.length) return { status: 'waiting' };
  if (uniqueImages.length !== 1) return { status: 'ambiguous_result', count: uniqueImages.length };
  if (downloadControls.length === 0 && directDownload && /^https?:\/\//i.test(uniqueImages[0].src)) {
    return { status: 'ready', image: uniqueImages[0], downloadControl: null, downloadMode: 'direct' };
  }
  if (downloadControls.length !== 1) return { status: 'download_unavailable', count: downloadControls.length };
  return { status: 'ready', image: uniqueImages[0], downloadControl: downloadControls[0] };
}

export function planWebMonitorAction({ observation, downloadRequested = false } = {}) {
  if (downloadRequested) return { status: 'download_pending' };
  if (observation?.status === 'ready') {
    return {
      status: 'request_download',
      image: observation.image,
      downloadControl: observation.downloadControl,
      ...(observation.downloadMode ? { downloadMode: observation.downloadMode } : {}),
    };
  }
  return { status: observation?.status ?? 'waiting' };
}

export function ensureSingleImagePrompt(prompt) {
  const value = String(prompt ?? '').trim();
  if (!value) return '';
  if (/(?:只|仅|仅需|必须)\s*(?:生成|输出)\s*(?:1|一)\s*(?:张|幅)?\s*(?:图片|图|image|picture)/i.test(value)
    || /(?:exactly|only|single)\s+(?:one|1)\s+(?:image|picture)/i.test(value)) return value;
  return `${value}\n\n输出约束：仅生成 1 张图片；不要生成图片组、拼图、多张变体或候选。`;
}

export function createWebDownloadTracking({ batchPath, task_id, tabId, conversationUrl, sourceUrl = null } = {}) {
  const normalizedConversationUrl = normalizeConversationUrl(conversationUrl);
  if (!batchPath || !task_id || !Number.isInteger(tabId) || !normalizedConversationUrl) return null;
  return {
    batchPath: String(batchPath),
    task_id: String(task_id),
    channel: 'web',
    tabId,
    conversationUrl: normalizedConversationUrl,
    sourceUrl: sourceUrl ? String(sourceUrl) : null,
  };
}
