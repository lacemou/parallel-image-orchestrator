export function buildDispatchPlan({ confirmed, allowedAttachments, tasks }) {
  if (!confirmed) return { ok: false, reason: 'batch_not_confirmed' };
  const allowed = new Set(allowedAttachments ?? []);
  for (const task of tasks) if ((task.attachments ?? []).some((file) => !allowed.has(file))) return { ok: false, reason: 'attachment_not_allowlisted' };
  return {
    ok: true,
    tasks: tasks.map((task) => ({
      task_id: task.task_id,
      variable_prompt: task.variable_prompt ?? task.prompt ?? '',
      ...(task.prompt_source ? { prompt_source: task.prompt_source } : {}),
      attachments: task.attachments ?? [],
    })),
  };
}
