export function initialAssignments(taskIds, limit = 5) {
  let codex = 0;
  let web = 0;
  return taskIds.map((task_id) => {
    let channel = 'queued';
    if (codex < limit && (codex <= web || web === limit)) { channel = 'codex'; codex += 1; }
    else if (web < limit) { channel = 'web'; web += 1; }
    return { task_id, channel };
  });
}

export function nextAssignment(queuedTaskIds, freedChannel) {
  return queuedTaskIds.length ? { task_id: queuedTaskIds[0], channel: freedChannel } : null;
}
