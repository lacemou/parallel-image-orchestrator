# Parallel Image Orchestrator

[English README](README.en.md)

面向 Codex Desktop 与已登录 ChatGPT Project 的本地批量生图编排器。它不保存 Cookie、密码、令牌或聊天内容。

## 先理解：它会做什么

这不是新的生图模型，而是一个“分工、排队、监控和归档”工具：一次要生成 4 张或更多图片时，它把任务分给本地 Codex 和 ChatGPT 网页端并行处理。本地 Codex 与网页端是两条独立启动链路；批次会先创建并返回扩展载入路径，拿到路径后再单独启动本地 Codex 或准备网页端。

它不需要 OpenAI API Key，也不会替你绕过登录、验证码或发送确认。

网页端最后的 **发送** 仍由你在每个 ChatGPT 页面手动点击。发送后，扩展会自动监控生成结果、下载图片并保存到本批次的 `图片/` 文件夹；当某个通道空出位置时，它会准备下一页，但新网页任务仍需要你点击发送。本地 Codex 只有在你收到批次路径后单独确认“开始本地生成”才会启动，不需要等待网页端。

只生成 1–3 张图片时，不需要启动这个编排器，直接使用 Codex 或 ChatGPT 即可。

## 普通用户：第一次使用

### 先准备 5 件事

1. 安装本 Skill、Chrome 扩展和本机桥接组件（让扩展可以把图片写入本地文件夹）。v0.2.6 提供预编译 Windows Host；macOS 继续使用本机编译安装，Linux 尚未实现。
2. 在 Chrome 登录 ChatGPT，并打开要使用的 ChatGPT Project。
3. 如果有固定视觉规范、示例图或人物参考图，请先上传到这个 Project；没有也可以继续，提示词会按你的要求执行。
4. 为每张图片准备一个 Markdown 提示词：`001.md`、`002.md`、`003.md`……文件名就是任务编号；也可以把完整提示词直接交给 Skill。
5. 确认每个任务只要求生成一张图片；网页任务会自动补上“一张图片”的保护语句。

### 1. 先让 Skill 读取提示词（只展示，不创建批次）

在 Codex 当前对话中发送下面的内容，把路径换成实际的提示词目录：

```text
使用 parallel-image-orchestrator。
提示词来源目录：/绝对路径/提示词目录
请读取该目录下的所有 Markdown 文档，每一张图片对应一个生图任务。
请先展示任务编号、提示词标题和分配方案，暂时不要创建批次，也不要发送网页任务。
不要修改提示词文件。
```

Skill 会先列出任务和分配结果。请检查任务数量、编号、提示词和 Codex / 网页端分配；这一步不会创建批次、网页或消息。

### 2. 确认分配后先创建批次并返回路径

确认清单无误后，在同一段 Codex 对话中发送：

```text
已确认任务分配方案，请立即创建批次并返回路径。
暂时不要创建本地 Codex 任务，也不要发送任何网页任务。
批次根目录使用：/绝对路径/批次存放目录

创建完成后，请返回：
1. batch_id
2. 当前批次目录
3. extensionLoadPath
4. 图片归档目录
```

这一步只创建 `manifest.json`、事件日志和 `图片/` 目录，不创建本地 Codex 对话，也不创建或发送网页任务。`/绝对路径/批次存放目录` 是占位写法，必须替换成真实存在的绝对路径；不能原样输入。

如果你只回复“已确认分配方案”，Skill 应先创建批次并返回路径，然后继续询问：

> 分配方案已确认。是否现在启动本地 Codex 生成任务？回复“开始本地生成”即可。

拿到路径后，你可以先把它粘贴到扩展中；不要等待本地图片生成完成。

这一步返回的四个字段用途如下：

| 返回值 | 用途 |
|---|---|
| `batch_id` | 本批次的唯一编号，用于恢复和查询。 |
| `当前批次目录` | 包含 `manifest.json` 和 `图片/` 的工作目录。 |
| `extensionLoadPath` | 与当前批次目录相同；完整复制到 Chrome 扩展。 |
| `图片归档目录` | 最终图片保存位置；无需填写给扩展。 |

`extensionLoadPath` 的实际形态是：`/你的批次存放目录/图片批次_<batch_id>/`。打开这个目录应该能看到 `manifest.json` 和 `图片/` 文件夹；复制到扩展时要包含最后的批次目录，不要只复制上一级目录。

如果 Skill 已经直接创建批次，不要再次运行命令；直接使用它报告的 `extensionLoadPath`。如果你只拿到了 Markdown 目录，也可以使用下面的备用命令导入。

### 3. 单独启动本地 Codex（每张图一个对话）

拿到 `extensionLoadPath` 后，在 Codex 对话中发送：

```text
批次已创建。开始本地 Codex 生成。
每一张分配给本地 Codex 的图片单独新建一个 Codex Desktop 对话。
不要在当前对话内使用子智能体，也不要把多个图片任务合并到一个对话。
不要等待 Chrome 登录、网页预检、网页任务页或网页端发送。
```

Skill 必须对每一个分配给 Codex 的任务单独调用 Codex Desktop 的独立任务接口；不得把 4 张图拆成当前对话内的 4 个智能体。创建本地任务后，你可以同时在扩展中准备并发送网页任务。此阶段返回实际已创建的本地 Codex 任务编号；如果任务仍在设置中，只能标记为待创建，不能把临时 setup handle 当成任务编号。

### 4. 在扩展中准备网页任务（与本地 Codex 并行）

1. 打开扩展设置页，点击“检查本机桥接”和“检查当前 Project”。这是网页分支的前置检查，不影响已经启动的本地 Codex。
2. 把 **扩展载入路径（`extensionLoadPath`）** 粘贴到“当前批次目录（包含 manifest.json）”，点击“载入批次（不发送）”。这一步只读取任务清单，不会创建网页或发送消息。
3. 勾选确认框，确认 Chrome 已登录、当前页面就是目标 Project，并核对任务和附件清单。任务中列出的参考图只会按已确认的清单上传。
4. 点击“创建 / 修复网页任务页”。这一步只会创建网页端任务页，不会发送。
5. 点击“一键验证并填入全部提示词”。扩展只显示“已载入/未载入”，不会在设置页展开长提示词。
6. 在每个网页任务页检查提示词和参考资料，然后手动点击 ChatGPT 的 **发送**。
7. 全部发送后，回到扩展点击“我已发送全部网页任务”。不需要逐页登记或捕获聊天地址。

之后扩展会在后台监控、下载和归档。你可以在批次目录的 `图片/` 文件夹查看结果。本地 Codex 即使已经完成或仍在生成，也不需要等待网页端操作。

### 5. 等待归档和动态补位

当网页图片已经生成、下载并归档后，网页通道才会释放位置。若还有排队任务，扩展会自动创建下一页并填入提示词，但不会自动点击发送。你可以发送一个就确认一个，也可以等多个新页面都发送后，再回到扩展一次性点击“我已发送全部网页任务”。

如果你暂时没有点击发送，网页通道会停在等待状态，不会自行生成、不会把该任务偷偷改派到 Codex，也不会重复发送；其他已经运行的本地 Codex 任务仍可继续。

### 分配规则

| 本批次图片数 | 初始安排 |
|---:|---|
| 1–3 张 | 不启动分发，只整理提示词。 |
| 4–10 张 | Codex 与网页端尽量对半分；奇数时 Codex 多 1 张。每个通道最多同时运行 5 张。 |
| 11 张及以上 | 先启动 Codex 5 张和网页端 5 张，其余进入队列；哪个通道完成并归档一张，下一张就补到哪个通道。总图片数没有 10 张的硬上限。 |

### 本地 Codex 图片会保存到哪里

调度器不决定 Codex 生图工具的原始保存位置。实际位置由 Codex 当前对话、项目设置和 `AGENTS.md` 中的保存要求决定；调度器只接收 Codex 明确返回的那张图片，再复制到本批次的 `图片/` 文件夹，不会用全局搜索去猜路径。

任务被分配到 Codex，只表示它进入 Codex 通道；本地启动时，每一张分配给 Codex 的图片必须对应一个独立 Codex Desktop 对话，不能在当前对话内拆成多个子智能体。若当前环境无法创建独立任务，不能降级为子智能体，也不能把“已分配”当成“已生成”，网页端任务仍可独立运行。

### 自动完成什么，仍需你做什么

| 扩展自动完成 | 你需要确认或点击 |
|---|---|
| 创建或修复网页任务页 | 确认批次和 Chrome 登录状态 |
| 填入并回读完整提示词 | 在每个网页标签页点击“发送” |
| 监控唯一生成结果并下载 | 新补位网页任务出现后再次点击“发送” |
| 按任务编号归档到 `图片/` | 检查最终图片是否符合你的视觉要求 |

扩展不会读取你的提示词目录，也不会自动上传 Project 共享资料；这些资料由你自己在 ChatGPT Project 中维护。

### 这几个文件分别给谁看

- `README.md`：普通用户的安装、操作和排错说明。
- `skill/parallel-image-orchestrator/SKILL.md`：给 Codex 读取的执行规则，普通用户不需要逐条执行。
- `docs/design/`：开发者和维护者使用的设计记录。

## 路径说明（需要填路径时看）

用户通常只需准备两种路径：提示词目录和批次存放目录。创建批次后，再把命令输出的扩展载入路径粘贴到 Chrome 扩展中。

最容易混淆的是两个“加载”动作：

1. 在 `chrome://extensions` 点击“加载已解压的扩展程序”时，选择仓库里的 `extension/` 文件夹。这是安装扩展，只做一次。
2. 在扩展设置页点击“载入批次（不发送）”时，粘贴本次任务的 **扩展载入路径**。它是新建的 `图片批次_<batch_id>/` 文件夹，里面必须有 `manifest.json`。这不是 `extension/` 文件夹，也不是提示词目录。

| 名称 | 你可以把它理解为 | 在哪里使用 |
|---|---|---|
| 扩展安装目录 | 仓库里的 `extension/` 文件夹；只在 Chrome 安装扩展时选择 | `chrome://extensions` |
| 提示词来源目录 | 放置 `001.md`、`002.md` 等文件的文件夹，也可以是带 `## 001` 章节的单个 Markdown 文件 | Codex / Skill |
| 批次根目录 | 用来存放新建批次文件夹的父目录 | Codex / Skill |
| 当前批次目录 / `extensionLoadPath` | 已创建且包含 `manifest.json` 的 `图片批次_<id>` 文件夹；这是要粘贴到扩展的路径 | Chrome 扩展设置页 |
| 图片归档目录 | 当前批次目录里的 `图片/` 文件夹；无需手动填写 | 扩展自动写入 |

提示词来源目录不会填写到扩展中。Skill 会在创建批次前读取 Markdown，将完整提示词写入 `manifest.json`，扩展只读取当前批次目录。

### 备用：直接用命令导入 Markdown 提示词

只有在 Skill 没有创建批次、只给了你提示词目录时，才需要运行下面的命令。它会读取编号 Markdown 文件，创建 `图片批次_<id>/`，并输出 `extensionLoadPath`；然后把这个输出路径粘贴到扩展。

在包含 `package.json` 的 `parallel-image-orchestrator` 文件夹中打开终端，运行：

```sh
npm run create-batch-from-prompts -- --prompt-dir /path/to/prompts --root /path/to/output
```

命令会输出 `extensionLoadPath`。请把它完整复制到扩展的“当前批次目录（包含 manifest.json）”输入框；不要粘贴提示词目录、批次根目录或 `图片/` 子目录。省略 `--root` 时使用当前工作目录。

如果提示词由一个深度 Codex 任务生成，先让它完成并写入 Markdown 文件，再运行这个批次创建命令；不要让扩展自己扫描本地目录。

## 常见提示怎么处理

| 扩展提示 | 处理方法 |
|---|---|
| `Specified native messaging host not found` | 确认扩展已加载、扩展 ID 与安装时完全一致，并从固定解压目录（包含 `package.json` 的项目根目录）重新执行 Windows 的 `--install` 和 `--check`；如果安装包被移动过，也必须重新安装。 |
| `npm error ... package.json ... ENOENT` | 说明当前终端不在项目根目录。先用 `Set-Location -LiteralPath '项目根目录'` 进入能看到 `package.json` 的目录，再运行 `npm test`。 |
| PowerShell 报告 `<` 运算符或 `RedirectionNotSupported` | `\<Chrome-extension-id>` 是文档占位符，不能原样输入。替换为真实的 32 位扩展 ID，并删除尖括号和反斜杠。 |
| `预检未通过` | 确认 Chrome 已登录 ChatGPT，打开正确的 Project，并让页面上的输入框可见；必要时刷新页面和扩展。 |
| `提示词填入后回读不一致` | 点击“重置当前批次网页准备（不删除图片/对话）”，关闭旧任务页，再重新创建并填入。 |
| `部分页面还没有形成真实对话地址` | 回到对应 ChatGPT 页面点击发送；发送完成后再点击“我已发送全部网页任务”。 |
| `任务页已经关闭或失效` | 点击“创建 / 修复网页任务页”；扩展会尝试复用已有页面，不会自动重发提示词。页面只是加载缓慢或暂时无网络时，扩展会保留它；人工刷新后再验证并填入即可。 |
| 新网页任务出现但没有开始生成 | 这是预期行为：打开新页、检查提示词后，需要你手动点击发送。 |

## 详细流程（需要排错时再看）

前面的“第一次使用”已经覆盖日常操作；下面只解释分配规则、状态和恢复边界，遇到问题时再查阅。

1. Codex 根据当前项目的 `AGENTS.md` 和相关视觉规范，为每张图生成独立任务；少于 4 张时只输出提示词包。
2. 如果提示词已经写成 Markdown，用户向 Skill 提供提示词来源目录和批次根目录；Skill 读取并验证，但在展示分配阶段不创建批次或任务。也可以直接传入内联提示词。
3. 4 张及以上按 Codex 优先的初始均分分配，5 张为 Codex 3 / 网页 2。网页端的共享视觉规范由用户自行上传到选定的 ChatGPT Project（Markdown、示例图，或两者）；扩展不管理、复制或重新上传通用规范。
4. 用户确认分配方案后，Skill 立即创建新的 `图片批次_<batch_id>`，写入 `manifest.json` 与事件日志，返回 `batch_id`、当前批次目录、`extensionLoadPath` 和图片归档目录；这个动作不创建本地 Codex 任务、不等待 Chrome，也不发送网页消息。
5. 用户拿到路径后，可先在扩展设置页粘贴 `extensionLoadPath`（当前批次目录）并选择“载入批次（不发送）”。如果用户随后确认“开始本地 Codex 生成”，Skill 必须加载这个已有批次，并为每一个 Codex 任务单独创建一个 Codex Desktop 对话；不能再次创建批次，不能使用当前对话内的子智能体。创建完成后返回实际本地 Codex 任务编号。
6. 用户勾选“已核对并确认 Chrome 已登录”后，点击“创建 / 修复网页任务页”。扩展会同时打开当前所有已分配到网页端的待处理任务页（最多 5 页），并立即登记这些页面；如果个别页面因网络缓慢尚未显示输入框，页面会保留，用户可手动刷新后继续“验证并填入”。如果保存的 tab ID 失效，会先按已保存的对话 URL 或页面中唯一的提示词自动找回现有页面，只有无法安全匹配时才创建替代页；不会发送消息。网页预检失败只暂停网页分支。
7. 点击“一键验证并填入全部提示词”。新建的每个 tab 会作为一个独立任务页；验证会先检查全部页面属于同一 Project、tab 仍然存在、输入框为空，并拒绝已经重复的真实对话。扩展只选择实际渲染的可见编辑器（ChatGPT 页面可能同时存在隐藏 `textarea` 和可见 `contenteditable`），逐页聚焦并填入后回读可见输入框，确认完整提示词（包括长 Markdown 展开后的内容）确实存在，再显示“已载入”；如果 CDP 文本输入在页面重绘期间没有生效，会自动用一次页面输入事件路径重试，仍失败时报告具体任务编号。不会在扩展页面复制展示提示词正文。此时 Project 首页仍可填入，因为真实 `/c/<conversation>` 地址通常在发送后才生成。
8. 用户在网页端各页面手动点击发送；填入网页提示词时扩展会追加一次“只生成 1 张图片”的任务级约束（已有同义约束不会重复追加）。完成后回到扩展点击“我已发送全部网页任务”，扩展只记录状态为 `generating`，不会代替用户发送。
9. 用户确认全部网页任务已发送后，扩展启动后台完成监控。它只观察已登记的对话：检测到唯一生成结果后调用网页自己的 Download/Save 控件，并把 Chrome 下载自动归档到批次目录；不会再次发送提示词。结果不唯一、对话地址不匹配、下载失败或页面失联会写入 `blocked`，不会自动重生成。

### 重新开始当前网页准备

如果填入提示词时中途停止、误用了旧任务页，或扩展报告“提示词填入后回读不一致”，先在批次页面勾选确认，再点击 **重置当前批次网页准备（不删除图片/对话）**。这个动作只清除当前批次中尚未发送的网页任务的扩展映射、未发送状态和监控残留，并把它们放回 `queued`；已发送、生成中、已完成或已归档的任务不会被回退。它不会删除 Markdown、批次图片、ChatGPT 对话、登录状态或浏览器 Cookie。

重置后请关闭旧任务页，再重新执行“创建 / 修复网页任务页”与“一键验证并填入全部提示词”。旧页面不会由扩展自动关闭，以免误关用户正在查看的对话。

## 安装与预检

首次安装只需要做一次。Codex 的 Computer Use 可以协助打开 Chrome，但不是必需条件；扩展安装和网页端发送也可以用普通 Chrome 操作完成。

1. 按 Codex 的 Skill 安装方式安装本仓库中的 `skill/parallel-image-orchestrator/`。
2. 打开 Chrome 的 `chrome://extensions`，开启“开发者模式”，点击“加载已解压的扩展程序”，选择本仓库的 `extension/` 文件夹。
3. 在扩展卡片上复制 32 位扩展 ID，然后在项目根目录运行下面的命令。这里的扩展 ID不是 ChatGPT Project ID。

### Windows（v0.2.6）

Windows 发布包已经包含预编译的 `native-host/parallel-image-native-host.exe`。安装器会检查 Host、bridge 和 Node.js，生成当前机器专用的 manifest，并把它注册到当前用户的 Chrome Native Messaging 注册表，不要求管理员权限。

#### 先解压到固定位置

请把完整的 `parallel-image-orchestrator-v0.2.6-source.zip` 解压到一个不会被清理、移动或改名的目录，例如：

```text
C:\Tools\parallel-image-orchestrator-v0.2.6\
```

下面的命令必须在解压后的项目根目录运行，也就是能够同时看到 `package.json`、`scripts\`、`bridge\` 和 `native-host\` 的目录。不要在 ZIP 压缩包内、下载临时目录或 `C:\Windows\System32` 中运行 `npm test` 或安装脚本。

安装器生成的 manifest 会记录这个目录下的 Host 和 bridge 的绝对路径。如果安装后移动、改名或删除该目录，扩展会再次报告 `Specified native messaging host not found`；请把目录放回原位置，或移动完成后从新目录重新执行一次 `--install`。

#### 安装与检查

先在 `chrome://extensions` 加载本发布包中的 `extension\` 文件夹，并复制扩展卡片显示的 32 位扩展 ID。然后在 PowerShell 中执行：

```powershell
$pioRoot = 'C:\Tools\parallel-image-orchestrator-v0.2.6'
$extensionId = 'YOUR_EXTENSION_ID'
Set-Location -LiteralPath $pioRoot

Test-Path .\package.json
Test-Path .\scripts\install-native-host.mjs

npm test
node .\scripts\install-native-host.mjs $extensionId --install
node .\scripts\install-native-host.mjs $extensionId --check
```

把 `C:\Tools\...` 换成你实际的固定解压目录，把 `YOUR_EXTENSION_ID` 换成 Chrome 扩展卡片上的真实 ID；不要输入尖括号，也不要保留这个占位文本。两个 `Test-Path` 都应返回 `True`。`npm test` 通过后，`--check` 应报告 `ok: true` 且 `issues` 为空。

manifest 会写入 `%LOCALAPPDATA%\Parallel Image Orchestrator\NativeMessagingHosts\`；它不会作为机器专用文件进入源码包。卸载时仍需在同一个项目根目录执行：

```powershell
node .\scripts\uninstall-native-host.mjs $extensionId
```

如果浏览器扩展卡片显示的 ID 与安装时使用的 ID 不一致，安装器不会替你注册错误的 `allowed_origins`。扩展 manifest 已包含稳定公钥；从本发布包加载时，重新加载扩展后应保持同一个 ID。

### macOS

macOS 安装器会使用本机的 Node.js、`clang` 和 `codesign` 编译并签名 Native Host：

```sh
node scripts/install-native-host.mjs YOUR_EXTENSION_ID --install
```

把 `YOUR_EXTENSION_ID` 换成 `chrome://extensions` 中显示的真实扩展 ID；不要输入尖括号。命令需要从包含 `package.json` 和 `scripts/` 的项目根目录运行。

Linux 安装流程尚未实现。

安装桥接后，在扩展设置页执行：

1. 检查本机桥接；
2. 保持目标 `https://chatgpt.com/g/.../project` 页面打开；
3. 检查当前 Project。

没有通过这两项检查时，批次确认页面不会执行网页投递。

升级扩展后需要在 `chrome://extensions` 点击“重新加载”。重新载入已有批次时，如果其中已经有用户手动发送并处于 `generating` 的网页任务，扩展会自动恢复完成监控；不需要再次填入或发送提示词。

## 发布前安全检查与打包

发布前先在仓库根目录执行完整测试、Windows Host 构建和审计：

```sh
npm test
npm run build:native-host:windows
npm run audit:release
```

审计会检查待发布源码和 Windows Host 中可扫描的文本内容，包括私钥、常见 API Token、Bearer 凭证、邮箱、本地绝对路径和 ChatGPT Project 地址，并且只输出文件名与行号，不输出匹配内容。默认只汇总被排除的本地文件；需要逐项查看时可运行 `node scripts/release-audit.mjs --verbose`。

审计通过后生成源码包：

```sh
npm run package:release
```

压缩包会写入 `release/parallel-image-orchestrator-v<版本>-source.zip`，同时输出 SHA-256 校验值。v0.2.6 包含独立本地 Codex 启动门禁、扩展、bridge、Skill、测试、设计文档、Windows Host 源码、预编译 Host、安装/卸载脚本和构建脚本；v0.2.5 是上一版可用包。

以下内容明确排除：

- `图片批次_*/`：可能含有真实聊天地址、任务提示词、下载图片和本机路径；
- `提示词_*/`：本地测试用提示词样例；
- `native-host/com.yj.parallel_image_orchestrator.json`：安装时生成的机器专用 manifest；
- 私钥、注册表导出、`release/`、`.git/`、`node_modules/` 和系统元数据。

Windows Host 依赖用户已有的 Node.js，不把 Node 运行时整体打包进发布包。当前可执行文件未配置代码签名证书，Windows SmartScreen 可能显示未签名提示；源码、构建命令和 SHA-256 会随发布记录保留。打包完成后应再检查 ZIP 文件清单、机器路径扫描和校验值。

## 状态约束

`queued → ready_to_send → generating → completed → archived` 是网页人工发送后的正常路径。扩展不会自动点击发送；只有用户确认已发送后才进入 `generating`。本地 Codex 任务的触发条件是当前批次的明确“开始本地 Codex 生成”确认，不受网页端 `queued`、Chrome 预检或人工发送影响。后台监控会限定在最新助手生图轮次，并按图片容器去重（不会把头像或模糊背景当成额外结果）；页面没有可见 Download/Save 控件时，会使用该生成图片的 HTTPS 地址发起一次受控下载。下载完成后先原子地记录 `completed` 并释放同一通道的下一个排队任务，再执行归档。新网页任务只会自动创建页面并填入提示词，仍需用户手动点击发送。`dispatching` 或 `generating` 遇到断连、地址不匹配、结果歧义或下载失败时会改为 `blocked`，防止重复生成；可恢复的旧监控阻塞在载入批次时自动重试一次（不重发提示词），也可在扩展页点击“恢复阻塞的网页监控（不重发）”。每次状态写入都使用批次级本地锁，因此多个 Native Host 请求不会互相覆盖 `manifest.json`。

## 开发验证

`npm test` 覆盖批次创建、初始 3:2 分配、确认与附件白名单、状态恢复、版本化归档、Native Messaging 协议和 Codex/Web 调度命令。测试不会发送网页消息、上传文件或生成图片。
