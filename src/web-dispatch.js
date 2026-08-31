import { ensureSingleImagePrompt } from './web-monitor.js';

export function buildWebDispatchCommand({ confirmed, loginConfirmed, task_id, prompt, attachments = [], allowedAttachments = [] }) {
  if (!confirmed || !loginConfirmed) return { ok: false, reason: 'batch_or_login_not_confirmed' };
  if (!task_id || !prompt) return { ok: false, reason: 'task_input_missing' };
  const allowed = new Set(allowedAttachments);
  if (attachments.some((file) => !allowed.has(file))) return { ok: false, reason: 'attachment_not_allowlisted' };
  return { ok: true, type: 'pio.web.dispatch', confirmed: true, loginConfirmed: true, task_id, prompt: ensureSingleImagePrompt(prompt), attachments: [...attachments], allowedAttachments: [...allowedAttachments] };
}
