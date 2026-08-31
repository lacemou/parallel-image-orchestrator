export function buildAttachmentUpload({ confirmed, projectUrl, allowedAttachments = [], files = [] }) {
  if (!confirmed) return { ok: false, reason: 'batch_not_confirmed' };
  if (!/^https:\/\/chatgpt\.com\/g\/[^/]+\/project\/?$/.test(projectUrl || '')) return { ok: false, reason: 'invalid_project_url' };
  const allowed = new Set(allowedAttachments);
  if (!files.length || files.some((file) => !allowed.has(file))) return { ok: false, reason: 'attachment_not_allowlisted' };
  return { ok: true, files: [...files] };
}
