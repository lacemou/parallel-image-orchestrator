# Parallel Image Orchestrator

[中文说明](README.md)

A local batch-image orchestration tool for Codex Desktop and a logged-in ChatGPT Project. It coordinates local Codex generation and ChatGPT web generation without storing cookies, passwords, tokens, or chat contents.

## What it does

For batches of four or more images, the tool distributes individual image prompts across two independent channels:

- **Local Codex:** starts only after the user explicitly confirms local generation. It never waits for Chrome, a web preflight, or a web send action.
- **ChatGPT web:** prepares one task page per web task, fills each prompt, and waits for the user to click **Send**. It never sends a ChatGPT message on the user's behalf.

After a web image is generated, the extension monitors the mapped conversation, downloads exactly one confirmed result, and archives it in the batch's `图片/` folder. When a channel becomes available, the next queued task is assigned to that same channel.

Use this tool only for batches of four or more images. For one to three images, use Codex or ChatGPT directly.

## Quick start

### Before you begin

1. Install this Skill, the Chrome extension, and the local native host.
2. Sign in to ChatGPT in Chrome and open the target ChatGPT Project.
3. Upload any shared visual references to that Project yourself, when needed.
4. Prepare one Markdown prompt per image, for example `001.md`, `002.md`, and `003.md`.
5. Make sure every prompt requests exactly one image.

Windows packages include a prebuilt native host. macOS installs the native host by compiling and signing it on the local machine. Linux is not implemented.

### 1. Ask Codex to inspect prompts and propose an allocation

Send this in a Codex conversation, replacing the paths with your own:

```text
Use parallel-image-orchestrator.
Prompt source directory: /absolute/path/to/prompts/
Read every Markdown file in that directory. Each image is one generation task.
First show the task ID, prompt title, and allocation. Do not create a batch or send web tasks yet.
Do not modify the prompt files.
```

Codex should only show the resolved task list at this stage. Review task IDs, prompts, assignments, later attachments, and the batch root before confirming.

### 2. Confirm allocation and start local Codex generation

After confirming the allocation, send:

```text
The allocation is confirmed. Create the batch and start local Codex generation now.
Do not wait for Chrome sign-in, web preflight, web task-page creation, or web sends.
Do not send any web tasks yet.
Batch root: /absolute/path/to/batch-output/
```

Local Codex tasks must start immediately. Web tasks remain queued until you separately decide to prepare them.

The batch response should include:

| Field | Meaning |
|---|---|
| `batch_id` | Unique batch identifier. |
| Batch directory | Contains `manifest.json` and `图片/`. |
| `extensionLoadPath` | The batch directory to paste into the extension. |
| Archive directory | The batch directory's `图片/` folder. |
| Local Codex task IDs | The isolated tasks started for the Codex channel. |

### 3. Prepare web tasks

Web preparation is independent of local Codex generation.

1. Open the extension settings page and run **Check local bridge** and **Check current Project**.
2. Paste `extensionLoadPath` into **Current batch directory (containing manifest.json)** and load the batch.
3. Confirm that Chrome is signed in and the current page is the intended ChatGPT Project.
4. Select **Create / Repair web task pages**. The extension opens all currently assigned pending web pages in parallel, up to five pages.
5. If a page is slow or temporarily offline, it remains open. Refresh it manually, then continue; the extension does not close it automatically.
6. Select **Validate and fill all prompts**.
7. Review each page and click **Send** yourself.
8. Return to the extension and confirm that all web prompts were sent.

The extension fills and reads back visible composers, but never clicks ChatGPT's Send button. It also never reads the prompt directory directly: prompts are resolved into `manifest.json` before the batch is created.

## Allocation rules

| Number of images | Initial allocation |
|---:|---|
| 1–3 | Do not orchestrate; only prepare prompts. |
| 4–10 | Split as evenly as possible. Codex receives the extra task on an odd count. |
| 11+ | Start up to five Codex and five web tasks. The remaining tasks wait in the queue. |

When a completed task releases a channel, the oldest unassigned task is assigned to that channel. A web task still requires a human Send click after it is prepared.

## Paths you will see

| Name | Use it here |
|---|---|
| Extension directory | Select `extension/` once in `chrome://extensions` to load the unpacked extension. |
| Prompt source directory | Provide it to Codex or the batch-creation command. |
| Batch root | The parent directory where a new `图片批次_<id>/` folder is created. |
| Batch directory / `extensionLoadPath` | Paste it into the extension. It must contain `manifest.json`. |
| Archive directory | `图片/` inside the batch directory. Do not paste this into the extension. |

## Create a batch from the command line

Only use this when Codex has not already created a batch for you. In this repository's root directory, run:

```sh
npm run create-batch-from-prompts -- --prompt-dir /path/to/prompts --root /path/to/output
```

The command prints `extensionLoadPath`. Paste that complete batch path into the extension; do not paste the prompt directory, batch root, or `图片/` folder.

## Platform installation

### Windows

Download the Windows release ZIP and extract it to a stable location, for example `C:\Tools\parallel-image-orchestrator-v0.2.6\`. Do not run the tools from inside the ZIP, a temporary download location, or `C:\Windows\System32`.

Load the package's `extension\` directory in `chrome://extensions`, copy its 32-character extension ID, then run PowerShell in the extracted project root:

```powershell
$pioRoot = 'C:\Tools\parallel-image-orchestrator-v0.2.6'
$extensionId = 'YOUR_EXTENSION_ID'
Set-Location -LiteralPath $pioRoot

npm test
node .\scripts\install-native-host.mjs $extensionId --install
node .\scripts\install-native-host.mjs $extensionId --check
```

The installer creates a machine-specific Chrome Native Messaging manifest under the current user's local application-data directory. If you move or rename the extracted folder, run `--install` again from the new location.

### macOS

Download the macOS release ZIP, extract it to a stable location, load its `extension/` folder in Chrome, and copy the extension ID. From the extracted project root, run:

```sh
node scripts/install-native-host.mjs YOUR_EXTENSION_ID --install
```

The macOS installer uses the local Node.js runtime, `clang`, and `codesign` to compile and sign the native host.

After upgrading either platform's extension, select **Reload** for it in `chrome://extensions`.

## Troubleshooting

| Message or situation | What to do |
|---|---|
| `Specified native messaging host not found` | Reload the extension, then rerun the native-host installer with the exact current extension ID. |
| `npm error ... package.json ... ENOENT` | Change into the extracted project root before running npm commands. |
| A web task page is slow or empty | Keep the page open, refresh it manually, then run prompt validation again. |
| Prompt readback mismatch | Use **Reset current batch web preparation (does not delete images/conversations)**, close obsolete task pages yourself, then prepare and fill again. |
| A new web page does not generate an image | Review the prompt and click **Send** yourself. This is expected. |

## Privacy and safety boundaries

- The extension never automatically sends a ChatGPT message.
- It does not inspect browser cookies, local storage, history, or other tabs.
- Attachments must be in the batch's confirmed per-task allowlist.
- Prompt directories are never read by the Chrome extension.
- Release packages exclude batches, prompt fixtures, generated native-host manifests, private keys, registries, `node_modules`, and system metadata.

## Development and release checks

Run these commands from the repository root before making a release:

```sh
npm test
npm run build:native-host:windows
npm run audit:release
npm run package:release
```

The audit scans published files for likely secrets, personal paths, and real ChatGPT Project URLs, without printing matched secret values. The source release manifest lists package files and checksums for integrity verification; it does not contain user batches, prompts, credentials, or machine-specific configuration.
