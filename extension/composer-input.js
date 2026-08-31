export function buildNativeComposerInputCommand(prompt) {
  if (!String(prompt ?? '').trim()) throw new Error('prompt_empty');
  return { method: 'Input.insertText', params: { text: prompt } };
}

export function normalizeComposerText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isPromptLoaded(draft, prompt) {
  const expected = normalizeComposerText(prompt);
  const actual = normalizeComposerText(draft);
  return Boolean(expected && actual.includes(expected));
}

export async function waitForPromptLoaded(readDraft, prompt, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  if (typeof readDraft !== 'function') throw new Error('prompt_reader_missing');
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const draft = await readDraft();
    if (isPromptLoaded(draft, prompt)) return { ok: true, status: 'prompt_loaded' };
    if (Date.now() >= deadline) throw new Error('prompt_not_loaded');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
