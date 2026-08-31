const batchPath = document.querySelector('#batch-path');
const result = document.querySelector('#result');
const summary = document.querySelector('#batch-summary');
const confirmationRow = document.querySelector('#confirmation-row');
const confirmation = document.querySelector('#batch-confirmed');
const prepareWeb = document.querySelector('#prepare-web');
const fillWeb = document.querySelector('#fill-web');
const confirmAllSent = document.querySelector('#confirm-all-sent');
const retryMonitor = document.querySelector('#retry-monitor');
const resetWeb = document.querySelector('#reset-web');
const resetWebHelp = document.querySelector('#reset-web-help');
let loadedBatch = null;
let projectEvidence = null;
let preparedItems = {};

chrome.storage.local.get(['batchPath']).then((stored) => {
  batchPath.value = stored.batchPath || '';
}).catch(() => {});

function show(text) { result.textContent = text; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }

const knownStatusTones = new Set(['queued', 'ready_to_send', 'generating', 'completed', 'archived', 'blocked']);
function statusTone(value) {
  const normalized = String(value ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return knownStatusTones.has(normalized) ? normalized : 'neutral';
}
function statusChip(label, tone = 'neutral') {
  return `<span class="status-chip status-${statusTone(tone)}">${escapeHtml(label)}</span>`;
}
function promptTone(task) {
  const status = promptStatus(task);
  if (status === '已发送') return 'completed';
  if (status.includes('阻塞')) return 'blocked';
  if (status.includes('待你')) return 'ready_to_send';
  return 'queued';
}

function webAction(task) {
  if (task.assigned_channel !== 'web') return '不适用';
  if (task.status === 'queued') return '待创建/验证独立聊天';
  if (task.status === 'ready_to_send') return '待你点击发送';
  if (task.status === 'generating') return '已发送，等待生成';
  if (task.status === 'completed') return '已完成，待归档';
  if (task.status === 'archived') return '已归档';
  if (task.status === 'blocked') return `阻塞：${task.last_error?.reason || task.last_error?.error || '请检查监控'}`;
  return task.status;
}

function promptStatus(task) {
  if (task.assigned_channel !== 'web') return '不适用';
  if (['generating', 'completed', 'archived'].includes(task.status)) return '已发送';
  if (task.status === 'blocked' && task.web_conversation_url) return '已发送，监控阻塞';
  const prepared = preparedItems?.[task.task_id];
  if (task.status === 'ready_to_send' || prepared?.status === 'awaiting_manual_send' || prepared?.filled_at) return '已载入，待你发送';
  return '待载入';
}

function syncActionButtons() {
  const webTasks = loadedBatch?.tasks?.filter((task) => task.assigned_channel === 'web') ?? [];
  const confirmed = confirmation.checked;
  prepareWeb.disabled = !confirmed;
  fillWeb.disabled = !confirmed;
  confirmAllSent.disabled = !confirmed;
  retryMonitor.disabled = !confirmed || !webTasks.some((task) => task.status === 'blocked');
  resetWeb.disabled = !confirmed || !webTasks.some((task) => ['queued', 'ready_to_send'].includes(task.status));
}

function renderBatch(manifest, currentPath = batchPath.value.trim()) {
  const webTasks = manifest.tasks.filter((task) => task.assigned_channel === 'web');
  const attachments = [...new Set(webTasks.flatMap((task) => task.attachments ?? []))];
  const generating = webTasks.filter((task) => task.status === 'generating').length;
  const prepared = webTasks.filter((task) => task.status === 'ready_to_send').length;
  const completed = webTasks.filter((task) => ['completed', 'archived'].includes(task.status)).length;
  const blocked = webTasks.filter((task) => task.status === 'blocked').length;
  const monitorText = generating
    ? `完成监控：运行中（${generating} 个生成任务）；完成后自动下载并归档。`
    : prepared
      ? `完成监控：等待你发送（${prepared} 个网页任务）；发送后回到这里确认。`
      : `完成监控：${completed ? `已完成/归档 ${completed} 个` : '当前没有生成中的网页任务'}${blocked ? `；阻塞 ${blocked} 个` : ''}。`;
  const normalizedPath = String(currentPath ?? '').trim().replace(/[\\/]+$/, '');
  const archivePath = normalizedPath ? `${normalizedPath}/图片/` : '当前批次目录/图片/';
  const rows = manifest.tasks.map((task) => {
    const action = webAction(task);
    return `<tr><td>${escapeHtml(task.task_id)}</td><td>${escapeHtml(task.assigned_channel ?? '未分发')}</td><td>${statusChip(task.status, task.status)}</td><td>${statusChip(promptStatus(task), promptTone(task))}</td><td>${escapeHtml((task.attachments ?? []).join('\n') || '无')}</td><td>${escapeHtml(action)}</td></tr>`;
  }).join('');
  summary.innerHTML = `<div class="summary-header"><div><p class="summary-kicker">当前批次</p><h3>批次 ${escapeHtml(manifest.batch_id)}</h3></div><code class="batch-id">${escapeHtml(manifest.batch_id)}</code></div><dl class="summary-stats"><div><dt>网页任务</dt><dd>${webTasks.length}</dd></div><div><dt>网页端附件</dt><dd>${attachments.length ? attachments.length : '无'}</dd></div><div><dt>已完成 / 归档</dt><dd>${completed}</dd></div></dl><p class="path-list"><strong>当前批次目录：</strong><code>${escapeHtml(normalizedPath || '未设置')}</code><br><strong>图片归档目录：</strong><code>${escapeHtml(archivePath)}</code></p><p>网页端附件清单：${attachments.length ? escapeHtml(attachments.join('、')) : '无'}。</p><p>${escapeHtml(monitorText)}</p><p>提示词内容不在此页展开；扩展会在填入后回读对应输入框，确认完整提示词已载入，再提示你点击发送。</p><p class="warning">流程：创建 / 修复任务页 → 一键验证并填入 → 你在各页点击发送 → 回到这里一次性确认已发送。完成监控只观察已确认的独立对话，不会再次发送提示词；下载完成后自动归档。新释放的网页槽位会自动创建并填入下一个排队任务，但仍需你在新页面点击发送。</p><div class="table-wrap"><table><thead><tr><th>编号</th><th>通道</th><th>状态</th><th>提示词状态</th><th>附件</th><th>网页聊天</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  summary.classList.remove('hidden');
  confirmationRow.classList.remove('hidden');
  prepareWeb.classList.remove('hidden');
  fillWeb.classList.remove('hidden');
  confirmAllSent.classList.remove('hidden');
  retryMonitor.classList.toggle('hidden', blocked === 0);
  resetWeb.classList.remove('hidden');
  resetWebHelp.classList.remove('hidden');
  syncActionButtons();
}

document.querySelector('#bridge-test').addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'pio.bridge.preflight' });
  show(response?.reason || (response?.ok ? '连接正常' : '连接失败'));
});

document.querySelector('#project-preflight').addEventListener('click', async () => {
  projectEvidence = await chrome.runtime.sendMessage({ type: 'pio.project.preflight' });
  const validProject = /^https:\/\/chatgpt\.com\/g\/[^/]+\/project\/?$/.test(projectEvidence?.projectUrl || '');
  show(validProject && projectEvidence?.composerVisible ? 'Project 就绪（发送前仍需逐批确认登录与附件）' : `预检未通过：URL=${projectEvidence?.projectUrl || '未收到网页证据'}；输入框=${projectEvidence?.composerVisible ? '已检测' : '未检测'}`);
});

document.querySelector('#load-batch').addEventListener('click', async () => {
  const path = batchPath.value.trim();
  if (!path) return show('请粘贴 Skill 输出的“扩展载入路径”（当前批次目录，必须包含 manifest.json）。');
  const response = await chrome.runtime.sendMessage({ type: 'pio.batch.load', batchPath: path });
  if (!response?.ok) return show(`无法载入批次：${describeWebError(response)}`);
  loadedBatch = response.manifest;
  preparedItems = response.prepared ?? {};
  await chrome.storage.local.set({ batchPath: path });
  renderBatch(loadedBatch);
  const resumed = response.resumed?.length ? `已自动恢复监控：${response.resumed.join('、')}（不重发提示词）。` : '';
  show(response.monitoring ? `批次已载入，已恢复网页完成监控；不需要重新填入或发送。${resumed}` : `批次已载入。请核对清单后勾选确认。${resumed}`);
});

confirmation.addEventListener('change', () => {
  syncActionButtons();
});
prepareWeb.addEventListener('click', async () => {
  if (!loadedBatch || !confirmation.checked || !projectEvidence?.composerVisible) return show('请先通过预检并勾选确认');
  const response = await chrome.runtime.sendMessage({ type: 'pio.batch.prepare_web', batchPath: batchPath.value.trim(), projectUrl: projectEvidence.projectUrl, confirmed: true });
  if (!response?.ok) return show(`创建/修复失败：${describeWebError(response)}`);
  const recreated = (response.results ?? []).filter((item) => item.status === 'recreated').map((item) => item.task_id);
  const created = (response.results ?? []).filter((item) => item.status === 'created').map((item) => item.task_id);
  const reused = (response.results ?? []).filter((item) => item.status === 'reused').map((item) => item.task_id);
  show(`网页任务页已登记：新建 ${created.join('、') || '无'}；替换失效页 ${recreated.join('、') || '无'}；复用 ${reused.join('、') || '无'}。\n页面尚未加载完成时会保留；请人工重新加载后，再点击“一键验证并填入全部提示词”。扩展会先确认所有页面输入框为空，避免重复填入。`);
});

fillWeb.addEventListener('click', async () => {
  if (!loadedBatch || !confirmation.checked) return show('请先载入批次并勾选确认');
  const response = await chrome.runtime.sendMessage({ type: 'pio.batch.fill_prepared_web', batchPath: batchPath.value.trim(), confirmed: true });
  if (response?.ok) show(`已验证并载入全部网页提示词：${(response.results ?? []).map((item) => item.task_id).join('、')}；每页输入框均已回读确认。现在请分别在这些页面点击发送，完成后回到这里点击“我已发送全部网页任务”。`);
  else {
    const loadedIds = (response?.results ?? []).map((item) => item.task_id).join('、');
    const detailIds = (response?.details ?? []).filter((item) => item && item.ok === false).map((item) => item.task_id).filter(Boolean).join('、');
    const failedId = response?.failed_task_id
      ? `\n本次失败任务：${response.failed_task_id}（该页不会自动发送；其他已验证页面保持不变）`
      : detailIds
        ? `\n未通过预检任务：${detailIds}（未填入提示词）`
        : '';
    show(`未完成：${describeWebError(response)}${loadedIds ? `\n已经载入并验证：${loadedIds}` : ''}${failedId}`);
  }
  const loaded = await chrome.runtime.sendMessage({ type: 'pio.batch.load', batchPath: batchPath.value.trim() });
  if (loaded?.ok) { loadedBatch = loaded.manifest; preparedItems = loaded.prepared ?? {}; renderBatch(loadedBatch); }
});

retryMonitor.addEventListener('click', async () => {
  if (!loadedBatch || !confirmation.checked) return show('请先载入批次并勾选确认');
  const response = await chrome.runtime.sendMessage({ type: 'pio.web.retry_monitor', batchPath: batchPath.value.trim(), confirmed: true });
  const lines = (response?.results ?? []).map((item) => `${item.task_id}：${item.ok ? '已恢复监控' : `失败（${describeWebError({ reason: item.reason })}）`}`);
  show(response?.ok ? `已恢复阻塞网页监控（不重发提示词）。\n${lines.join('\n') || '没有可恢复的网页任务。'}` : `恢复监控失败：${describeWebError(response)}`);
  const loaded = await chrome.runtime.sendMessage({ type: 'pio.batch.load', batchPath: batchPath.value.trim() });
  if (loaded?.ok) { loadedBatch = loaded.manifest; preparedItems = loaded.prepared ?? {}; renderBatch(loadedBatch); }
});

resetWeb.addEventListener('click', async () => {
  if (!loadedBatch || !confirmation.checked) return show('请先载入批次并勾选确认');
  const resettable = loadedBatch.tasks.filter((task) => task.assigned_channel === 'web' && ['queued', 'ready_to_send'].includes(task.status));
  if (!resettable.length) return show('当前没有尚未发送的网页任务可重置；已发送、生成中和已归档任务会被保护。');
  const ids = resettable.map((task) => task.task_id).join('、');
  if (!window.confirm(`将重置网页任务 ${ids} 的扩展准备状态。不会删除图片、ChatGPT 对话或登录状态；旧任务页不会自动关闭。继续吗？`)) {
    return show('已取消重置。');
  }
  const response = await chrome.runtime.sendMessage({ type: 'pio.batch.reset_web_preparation', batchPath: batchPath.value.trim(), confirmed: true });
  if (!response?.ok) return show(`重置失败：${describeWebError(response)}`);
  confirmation.checked = false;
  const loaded = response.manifest?.tasks ? response : await chrome.runtime.sendMessage({ type: 'pio.batch.load', batchPath: batchPath.value.trim() });
  if (loaded?.ok) {
    loadedBatch = loaded.manifest;
    preparedItems = loaded.prepared ?? {};
    renderBatch(loadedBatch);
  }
  const resetIds = (response.reset_task_ids ?? []).join('、') || '无';
  show(`已重置网页准备状态：${resetIds}。请关闭旧任务页，然后重新执行“创建 / 修复网页任务页”→“一键验证并填入全部提示词”。不会自动发送。`);
});

confirmAllSent.addEventListener('click', async () => {
  if (!loadedBatch || !confirmation.checked) return show('请先载入批次并勾选确认');
  const response = await chrome.runtime.sendMessage({ type: 'pio.web.confirm_all_sent', batchPath: batchPath.value.trim(), confirmed: true });
  const lines = (response?.results ?? []).map((item) => `${item.task_id}：${item.ok ? '已记录' : `失败（${describeWebError({ reason: item.reason })}）`}`);
  const message = response?.ok
    ? response.monitoring
      ? '全部网页任务已记录，已启动完成监控；生成完成后自动下载归档。'
      : lines.length
        ? '网页任务已记录，但完成监控未启动；请检查保存的 Project 地址后重试。'
        : loadedBatch?.tasks?.some((task) => task.assigned_channel === 'web' && task.status === 'blocked')
          ? '没有新的网页发送需要记录。当前网页任务已阻塞；请点击“恢复阻塞的网页监控（不重发）”，不会再次发送提示词。'
          : '没有新的网页发送需要记录。'
    : '部分网页任务未记录：';
  show(`${message}\n${lines.join('\n') || (response?.ok ? '' : describeWebError(response))}`);
  const loaded = await chrome.runtime.sendMessage({ type: 'pio.batch.load', batchPath: batchPath.value.trim() });
  if (loaded?.ok) { loadedBatch = loaded.manifest; preparedItems = loaded.prepared ?? {}; renderBatch(loadedBatch); }
});

setInterval(async () => {
  if (!loadedBatch || !batchPath.value.trim()) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'pio.batch.load', batchPath: batchPath.value.trim() });
    if (response?.ok) {
      loadedBatch = response.manifest;
      preparedItems = response.prepared ?? {};
      renderBatch(loadedBatch);
    }
  } catch {
    // An extension reload can invalidate this page; the user can refresh it safely.
  }
}, 5000);

function describeWebError(response) {
  if (!response) return '扩展没有返回结果，请重新加载扩展后重试';
  if (response.reason === 'batch_manifest_missing') return '找不到 manifest.json。请粘贴 Skill 输出的“扩展载入路径”，不要填提示词目录、批次根目录或“图片”子目录。';
  if (response.reason === 'batch_manifest_invalid') return 'manifest.json 无法读取。请确认粘贴的是完整当前批次目录，并重新创建批次。';
  if (response.reason === 'prepared_task_tab_missing') return '扩展已尝试按对话 URL 和唯一提示词找回现有页面，但仍有任务页无法安全识别；请点击“创建 / 修复网页任务页”处理缺失页面，不会自动重发提示词。';
  if (response.reason === 'conversation_urls_not_ready') return '部分页面还没有形成真实对话地址。请先在这些页面完成发送，再点击“我已发送全部网页任务”。';
  if (response.reason === 'conversation_urls_not_unique') return '检测到多个任务的真实对话地址相同。请点击“创建 / 修复网页任务页”重新准备，避免把同一对话重复记录。';
  if (response.reason === 'composer_not_empty') return '至少一个页面已有草稿。为避免重复提示词，本次已停止；请使用“重置当前批次网页准备”并关闭旧任务页后再验证。';
  if (response.reason === 'composer_not_visible') return '至少一个任务页输入框尚未就绪。请等待页面加载完成后再验证。';
  if (response.reason === 'prompt_not_loaded') return '提示词填入后回读不一致，本次已停止；请使用“重置当前批次网页准备”并关闭旧任务页后重新验证，不会自动发送。';
  if (response.reason === 'prepared_task_wrong_project') return '有任务页已经离开了选定的 ChatGPT Project。请点击“创建 / 修复网页任务页”重新准备。';
  if (response.reason === 'conversation_url_mismatch') return '发送确认时发现页面对话地址发生变化，本次未记录；请重新准备并核对任务页。';
  if (response.status === 'needs_reprepare') return '任务页映射已失效，请点击“创建 / 修复网页任务页”后再继续。';
  if (response.reason === 'ambiguous_result') return '检测到多个候选生成结果，已停止自动下载；请在对应网页确认只保留一个结果后再处理。';
  if (response.reason === 'download_unavailable') return '已检测到生成结果，但未找到唯一的下载控件；请检查网页后再重试。';
  if (response.reason === 'direct_download_failed') return '已找到生成图片，但直接下载失败；请确认网页仍保持登录并重试监控。';
  return response.reason || response.error || '未知错误';
}
