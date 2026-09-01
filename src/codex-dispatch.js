export function buildCodexTaskRequest(task) {
  const attachments = (task.attachments ?? []).map((path) => `参考图：${path}`).join('\n');
  const prompt = task.variable_prompt ?? task.prompt ?? '';
  return {
    title: `PIO ${task.task_id}`,
    prompt: `这是 Parallel Image Orchestrator 的隔离生图任务 ${task.task_id}，运行在一个独立 Codex Desktop 对话中。\n这个对话只负责这一张图片。不得使用 multi_agent_v1__spawn_agent 或其他子智能体，也不得在当前对话内创建、管理或合并其他图片任务。\n仅使用内置 imagegen 生成一张图片。\n变量提示词：${prompt}\n${attachments}\n不修改项目文件；完成后仅复制 imagegen 工具返回的 savedPath 作为结果路径，不要运行全局 find、猜测或引用其他任务的 generated_images 文件。不要声称已归档或已发布。`
  };
}

export function buildCodexArchiveCommand({ confirmed, batchPath, task_id, sourcePath }) {
  if (!confirmed) return { ok: false, reason: 'batch_not_confirmed' };
  if (!batchPath || !task_id || !sourcePath) return { ok: false, reason: 'codex_result_input_missing' };
  return { ok: true, type: 'archive_codex_image', confirmed: true, batchPath, task_id, channel: 'codex', sourcePath };
}
