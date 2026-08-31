---
name: parallel-image-orchestrator
description: Use when four or more image tasks must be coordinated between Codex Desktop and a logged-in ChatGPT Project, especially when web preparation may be slow or blocked.
---

# Parallel Image Orchestrator

> 本文件是给 Codex 读取的执行规则。普通用户请先阅读仓库根目录的 `README.md`，不需要逐条执行这里的内部步骤。

Use this skill for four or more visual assets after the user confirms the per-image prompts. Local Codex generation and web preparation are separate branches: an explicit local-start confirmation must launch Codex without waiting for Chrome.

## Path input contract

At the start of a batch, accept these user inputs explicitly:

```text
提示词来源目录：/path/to/prompts/
映射规则：001.md 对应任务 001，002.md 对应任务 002。
批次根目录：/path/to/output/
```

The prompt source is optional when the user provides complete prompts inline. A prompt source may be a directory containing numbered files (`001.md`, `002.md`, …), or one Markdown file containing numbered headings such as `## 001` and `## 002`. Do not scan an entire project or guess a directory. If the path or mapping is missing, ask for it before creating the batch.

Read and resolve the Markdown locally before creating `manifest.json`. Store the complete prompt plus `prompt_source` metadata for each task. The Chrome extension must never read the prompt directory.

When this repository is available, use `npm run create-batch-from-prompts -- --prompt-dir <提示词目录> --root <批次根目录>` (or the equivalent `createBatchFromPromptDirectory` API) to make the import deterministic. The command's `extensionLoadPath` is the only path the user needs to copy into Chrome.

After creating a batch, report these two paths separately:

```text
扩展载入路径（请完整复制到 Chrome 扩展）：/path/to/output/图片批次_<id>/
图片归档目录（无需填写）：/path/to/output/图片批次_<id>/图片/
```

The extension path must be the directory containing `manifest.json`; it is not the prompt source directory, the batch root, or the `图片/` child directory.

## Start gates and independent branches

Treat every batch as three separate user-controlled gates:

1. **Allocation confirmation:** after resolving the prompts, show every task, every later attachment, the assignment, and the batch root. Do not create a batch or task during a display-only turn. Ask the user to confirm the allocation.
2. **Local Codex start confirmation:** immediately after the allocation is confirmed, ask exactly: `分配方案已确认。是否现在启动本地 Codex 生成任务？回复“开始本地生成”即可。` A current-batch reply such as `开始`、`开始本地生成` or `确认开始本地 Codex 生成` is the start signal. It authorizes immediate local dispatch; do not ask an open-ended “什么时候开始” after receiving it.
3. **Web preparation confirmation:** Chrome login, Project preflight, attachment upload, page preparation, and the human Send action apply only to web tasks. They are not prerequisites for local Codex dispatch.

The local-start gate is the authoritative trigger for Codex. Once it is confirmed, create the batch if needed, write the initial allocation, mark each assigned Codex task `dispatching`, and create all initially assigned isolated Codex Desktop tasks before starting or waiting on Chrome Project preflight. A confirmed local task must never remain silently `queued` because web preparation is slow. If local start is declined or postponed, do not create its Codex task and report it as awaiting local-start confirmation; do not infer consent later. A confirmation from another Codex task does not authorize this batch.

Web preparation may run before, after, or alongside local generation once its own confirmation and preflight are available. 网页端不得阻塞已经确认的本地 Codex 任务。The extension must never send a ChatGPT message automatically; the human performs every web Send click. If the web branch is blocked, local Codex tasks continue independently.

1. Build a task list with one identifier, prompt, ratio, output basename, and explicit reference-file allowlist per image. A batch may mix cover, body, and carousel images; their visual instructions belong in their individual prompts. If the user supplied a Markdown source directory, import it using the path contract above and map each file/section to a task id.
2. Codex tasks work in the project context and follow its `AGENTS.md` and relevant local visual documents. For web tasks, the user owns the selected ChatGPT Project's shared references (Markdown, example images, or both); explain that setup in the task instructions, but do not invent a separate Profile layer or re-upload common reference materials. Resolve each web task's assigned Markdown prompt into one complete prompt string before creating the batch; the extension receives that text and does not need to read the `.md` file itself.
3. Show every task, every file that would be uploaded later, and the batch directory. Confirm the allocation, then apply the local Codex start gate above. If the user only confirms the allocation, ask the local-start question once before doing any local dispatch.
4. When local Codex start is confirmed, create the batch and write the initial 3:2 / 5:5 allocation. Codex wins only initial ties; later capacity is filled by the first free channel. Use the user-selected batch root; if no root was configured, use the current conversation/project folder and state that default explicitly. Immediately dispatch every assigned Codex task using `buildCodexTaskRequest`: mark it `dispatching` before creation; after the task reports the exact `savedPath` returned by its own image-generation tool, mark it `generating` and send only `buildCodexArchiveCommand` to the local bridge. Never infer a path with a global file search, and never archive an unselected result. If the user postpones local start, leave those tasks unstarted and explicitly labeled as pending; do not let web work change that decision.
5. For the independent web branch, obtain the web confirmation and run Chrome Project preflight. Stop only the web branch when the selected Project URL or composer is unavailable; do not delay already confirmed Codex tasks.
6. For each web attachment, require it to appear in the confirmed allowlist. The Chrome extension uses its declared `debugger` permission only for the selected Project tab, runs `DOM.setFileInputFiles`, then detaches. Do not inspect cookies, local storage, history, or another tab.
7. Only after the web branch is confirmed may the extension open or repair task pages and fill allowlisted prompts/files. Each web task receives a single-image output guard unless its prompt already contains an equivalent one-image instruction. ChatGPT may expose a hidden textarea beside the rendered contenteditable, so the extension must select the rendered visible composer, bring each target tab to the front while filling, and read that same visible composer back. If a CDP insertion is swallowed during hydration, it may use one page-side input-event retry with replacement (never append blindly); it must report the failed task id if the retry still fails. After insertion, the extension reads the visible composer back and reports only a loaded/not-loaded status; it must not expose the full prompt in the options page. The human performs the final Send click; the extension must not send a ChatGPT message automatically. A blocked, uncertain, or already-started task must not be resent automatically.
8. Before filling web prompts, require every prepared page to still belong to the selected Project and have an empty composer. A fresh Project home is allowed because its `/c/<conversation>` URL may only appear after the user sends. If a saved tab ID is stale, first rebind an existing conversation page by its saved conversation URL or a unique prompt match; only an unresolved or ambiguous page is recreated on the next “创建 / 修复网页任务页” action. Never expose the raw Chrome tab error.
9. After the human sends all web tasks, use the batch-level confirmation to record `ready_to_send → generating` and start the background completion monitor; never ask the user to capture or register each task URL separately. The monitor observes the latest assistant turn in the mapped conversation and counts stable image-generation containers (layered `<img>` elements and profile avatars are ignored). It accepts exactly one generated image; if a page Download/Save control exists it clicks that unique control, otherwise it downloads the single HTTPS image source once through `chrome.downloads`, then waits for Chrome's download event before completing and archiving the task. It never sends a prompt. A completed web task releases its channel atomically; the next queued web task is prepared and filled but still requires the human Send click. When resuming, call `recover_batch` first. It may resume only `queued` or `retryable_failure` tasks; a known monitor-only block can be re-armed once without resending the prompt, while a task left in `dispatching` or `generating` for another reason remains `blocked` for user review.

If prompt filling stops with a readback mismatch, use the extension action **重置当前批次网页准备（不删除图片/对话）** after confirming the batch. This is a scoped reset: it returns only unsent web tasks (`queued` or `ready_to_send`) to `queued`, removes their local page/conversation preparation records, and leaves sent, generating, completed, and archived tasks untouched. It does not delete prompt files, images, ChatGPT conversations, login state, or browser credentials. Close obsolete task pages yourself, then run “创建 / 修复网页任务页” and “一键验证并填入全部提示词” again; the extension deliberately does not close tabs automatically.

Never inspect browser credentials or transmit files outside the confirmed allowlist. Before using the extension, install its native host manifest with the exact locally loaded extension ID; do not use the template placeholder as-is.
