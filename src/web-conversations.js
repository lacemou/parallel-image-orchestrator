export function normalizeProjectConversation(url) {
  const match = String(url ?? '').match(/^https:\/\/chatgpt\.com\/g\/[^/]+\/c\/[^/?#]+\/?$/);
  if (!match) throw new Error('conversation_url_invalid');
  return match[0].replace(/\/$/, '');
}

export function assertUniqueProjectConversations(urls) {
  const normalized = urls.map(normalizeProjectConversation);
  if (new Set(normalized).size !== normalized.length) throw new Error('conversation_urls_not_unique');
  return normalized;
}
