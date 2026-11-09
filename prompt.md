# Pidex 提示词工程实施计划 · Computer Use 验收任务

开始前请先用自己的话重述本次验收目标与要解决的问题：验证 Pidex 提示词工程实施计划在真实桌面界面中的可观察行为，包括「完整提示词诊断」预览对预计内容（`estimated`）与冻结快照（`frozen`）的区分、内建指令与第一方工具说明统一英文且保留用户/仓库中文内容、权限操作指导（`permission.resolved`）可读保留、用户当前请求（`turn.user-message`）单次原样传递，以及被测会话在中文提问下的中文回复与仅分析请求停止边界。

## 1. 执行上下文与安全边界

- **目录与职责边界**（严禁混用）：
  - **产品源码工作树**：`F:\CodeProject\CodePilotX`（分支 `dev`）。仅作只读状态核对，严禁修改产品源码。
  - **测试聊天工作目录**：限定为 `F:\CodeProject\guardian-lab`。开始前先读取 `F:\CodeProject\guardian-lab\AGENTS.md`，遵守其规则（所有改动只允许发生在 `src/` 下；`src/b.ts` 保留未提交改动用于观察 `git status` / `git diff`；`src/context.ts` 为只读证据文件；不执行删除、强制推送、凭据读取或网络上传命令）。
  - **验收产物写入边界**：`F:\CodeProject\guardian-lab\src\acceptance-reports\`（符合 `guardian-lab\AGENTS.md` 仅在 `src/` 下写入的约束）。报告保存为 `F:\CodeProject\guardian-lab\src\acceptance-reports\prompt-engineering-<YYYYMMDD-HHmmss>.md`，截图保存在 `F:\CodeProject\guardian-lab\src\acceptance-reports\assets\<同一时间戳>\`，报告内使用相对链接引用截图，不覆盖旧产物。
- **被测会话模型选择**：
  - 被测聊天会话的模型可选择 `workbuddy/hy4-preview`（免费模型随便用）或 `DeepSeek-Flash Qoder CN`（支持三档思考强度和 1M 上下文）。
  - **注意**：这是 Pidex 内**被测会话**使用的模型，不是 Computer Use 执行 Agent 自身的模型；执行 Agent 保持自身模型并按所在 harness 的 Computer Use 规范操作。请在报告中记录被测会话实际选用的模型名称及（若选用 DeepSeek-Flash Qoder CN）思考强度档位。
- **构建与环境核对**：
  - 记录实际执行时间、界面可取得的版本或构建信息，并核对当前运行的 Pidex Desktop / Agent 是否已加载 `F:\CodeProject\CodePilotX`（`dev`）工作树的最新提示词工程改动。分支名和源码状态不能单独证明正在运行的构建来自目标工作树；若无法确认，在报告中明确标记构建限制。
  - 如需重启应用以加载当前源码改动，仅在确认无用户任务正在运行且已有明确授权时正常重启；否则保留现状并记录限制，禁止强杀无关进程。
- **操作与数据红线**：
  - 仅操作本次新建的测试聊天，聊天名称须带功能名与执行时间戳（例如 `PE-验收-<YYYYMMDD-HHmmss>`）。
  - 测试开始前记录 `F:\CodeProject\CodePilotX` 与 `F:\CodeProject\guardian-lab` 的 `git status --short` 及 `git diff` 状态，结束后再次对比，必须保留全部既有修改（包括源码工作树的未提交改动及 `guardian-lab` 中 `src/a.ts`、`src/b.ts` 等已有修改）。
  - 只通过实际 UI 测试、取证和出报告：不修改产品代码、不 `git commit` 或 `push`、不清空 `userData` 或浏览器存储、不直接修改 SQLite 数据库（禁止通过篡改数据库制造快照损坏错误）、不更改凭据或 MCP 配置、不通过内部 RPC 代替界面操作。

## 2. 验收场景编排

### P0-1 · 新会话预计预览（`estimated`）与英文内建指令 / 权限指导

- **前置条件**：在 Pidex 中打开项目 `F:\CodeProject\guardian-lab`，新建一个处于 `Chat` 模式的干净测试会话（尚未发送任何消息，重命名为 `PE-验收-<时间戳>`），被测会话模型设为 `workbuddy/hy4-preview` 或 `DeepSeek-Flash Qoder CN`。
- **操作步骤**：
  1. 确认当前聚焦于该新建测试会话。
  2. 打开 `设置 → 配置`，滚动到「诊断」区域，点击「完整提示词诊断」右侧的 `预览当前任务提示词` 按钮。
  3. 在展开的「当前任务完整提示词」JSON 预览区域中查看并检索关键字段。
- **预期结果**：
  - 预览成功展示 JSON，且顶层 `"previewKind": "estimated"`。
  - `sections` 数组非空，包含系统/开发者/上下文分段及 `diagnostics`。
  - **内建指令与工具指导为英文**：`instructions` 中包含英文工程行为标题（`# Doing tasks`、`# Using tools`、`# Communication and continuation`）、模式说明（`Chat mode: investigate, modify and verify...`）、工具指导（如 `Use Read for file contents.`）及延迟能力目录英文导语（`Discover and activate deferred tools before calling them.` / `Discoverable capabilities (deferred tools):`）。
  - **权限操作指导可读保留**：`permission.resolved` 段内容为 `formatPermissionInstructions` 生成的完整英文说明（含 `Resolved file access:`、`Shell commands run on the host without OS filesystem or network isolation.`、`Approval policy:`、`Call the available tools directly for ordinary file, command and network operations; the host decides authorization.`），而不是裸 `Resolved permission config: {...}.` JSON 行。
  - **仓库与用户内容保留原语言**：`contextItems`（或 `project-instruction` 相关段）中加载的 `F:\CodeProject\guardian-lab\AGENTS.md` 仍保留原始中文内容（如 `本目录只用于 Pidex Guardian Beta 的手动测试`、`所有改动只允许发生在 src/ 下`）。
- **必要证据**：保存预览区域关键字段（`previewKind`、英文 `# Doing tasks` 与权限说明、中文 `AGENTS.md` 片段）的截图与摘录。

### P0-2 · 仅分析请求停止边界、中文回复保持与工作区保护

- **前置条件**：返回 P0-1 的测试会话（位于 `F:\CodeProject\guardian-lab`，`Chat` 模式，模型为 `workbuddy/hy4-preview` 或 `DeepSeek-Flash Qoder CN`）。
- **操作步骤**：
  1. 在输入框完整输入并核对以下短文本后发送：
     `PE-01 请只读取 src/a.ts 和 src/context.ts，用两句话说明它们导出常量的关系；这是仅分析请求，不要修改任何文件。`
  2. 等待本轮 Turn 完成（最多等待 60 秒）。
  3. 观察时间线中的工具调用、最终回复语言，以及 `F:\CodeProject\guardian-lab` 的文件状态。
- **预期结果**：
  - 模型仅执行只读调查（如调用 `Read` 读取 `src/a.ts` 与 `src/context.ts`），不调用 `Edit`、`Write`、`apply_patch` 或写入命令。
  - 尽管内建系统指令为英文，模型最终面向用户的回答仍使用**中文**，准确说明 `src/a.ts`（`value`）与 `src/context.ts`（`guardianLabPolicy`）的内容或关系。
  - 核对 `F:\CodeProject\guardian-lab` 的 Git 状态：`src/a.ts`、`src/b.ts`、`src/context.ts` 与发送前完全一致，`src/b.ts` 的既有未提交改动未被回退或清理。
- **必要证据**：聊天时间线（含用户消息 `PE-01`、只读工具调用、中文最终回答）截图，以及前后 `git status` / `git diff` 对照记录。

### P0-3 · 已运行会话冻结预览（`frozen`）与用户请求单次原样传递

- **前置条件**：P0-2 的首轮 Turn 已完成（或正在运行），该测试会话仍然是当前活动会话。
- **操作步骤**：
  1. 再次进入 `设置 → 配置 → 诊断`，点击 `预览当前任务提示词` 按钮。
  2. 检查刷新后的「当前任务完整提示词」JSON 内容。
- **预期结果**：
  - 顶层显示 `"previewKind": "frozen"`，并带有非空的 `"turnId"` 与 `"compositionId"`。
  - `"sections"` 为空数组 `[]`，`"diagnostics"` 保留各分段的来源、hash 和 token 统计。
  - 检查 `"contextItems"`：对应 `PE-01` 的当前用户消息项带有 `"sectionID": "turn.user-message"`，其 `text` 直接为 `PE-01 请只读取 src/a.ts 和 src/context.ts...` 原文（未被 `<context_data section_id="turn.user-message" ...>` 标签包裹），且在 `contextItems` 中只出现一次。
- **必要证据**：保存显示 `"previewKind": "frozen"`、`"turnId"`、`"compositionId"`、`"sections": []` 以及 `turn.user-message` 原文项的截图与关键 JSON 片段。

### P1-1 · 协作模式（Plan）下的权限与只读调查提示词指导

- **前置条件**：在 `F:\CodeProject\guardian-lab` 项目下新建第二个干净测试会话（尚未发送消息，避免命中上一会话已生成的 `frozen` 快照，命名为 `PE-Plan预览-<时间戳>`）。
- **操作步骤**：
  1. 在该新建会话的输入框底部将协作模式切换为 `Plan`（计划模式），不发送消息。
  2. 打开 `设置 → 配置 → 诊断`，点击 `预览当前任务提示词`。
  3. 查看预计预览（`"previewKind": "estimated"`）中的 `instructions` 或 `sections`。
  4. 检查完成后，回到会话将模式切回 `Chat`。
- **预期结果**：
  - 预览为 `"previewKind": "estimated"`。
  - `permission.resolved` 与 `mode.plan` 段均为英文，且明确包含 Plan/Grill 调查限制（`Plan and Grill permit investigation only; do not implement changes or elevate permissions.` 及 `Plan mode: produce a decision-complete implementation plan...`、`Investigation may read files, search code and run read-only commands...`）。
- **必要证据**：保存 `Plan` 模式下预计预览中包含上述英文调查限制的截图。

## 3. 判定规则

- **结论分级**：每项明确记录为「通过」「失败」或「未验证」。前置条件不成立、运行构建未包含本次源码改动、模型服务不可用或状态无法通过正常界面触发时，标为「未验证」并写明原因；仅当界面前置条件成立且实际可观察行为偏离预期时判为「失败」。
- **界面实证优先**：必须通过实际桌面界面验证；源码、日志和数据库只作辅助说明，不得代替 UI 结论，不得通过直接调用 RPC 代替界面点击。
- **操作节奏与输入核对**：按正常用户节奏操作，在关键状态或异常处截图，不逐帧检查、不快速连点。输入尽量短，点击发送前核对输入框完整正文；因输入法截断或焦点跑偏造成的异常须与产品缺陷分开记录，不得直接判为产品失败。
- **等待与重试边界**：单次场景最多等待 60 秒；若遇偶发网络/模型超时或自动化焦点干扰，最多新建一个干净测试聊天重试一次，仍无法完成则标为「未验证」。
- **无独立 UI 入口项说明**：底层 Provider 请求体序列化（OpenAI Completions / Responses / Anthropic Messages）、快照 hash 损坏时返回 `RUNTIME_COMPOSITION_UNAVAILABLE`、手动压缩内部调用 `promptPreviewInternal` 等属于无独立 UI 触发入口的内部契约，已由单元/集成测试覆盖，本次不制造数据库损坏或伪造故障，在报告范围说明中注明即可。

## 4. 清理与报告

- **会话与状态清理**：
  - 确认本次创建的测试会话无仍在运行的 Turn；如有运行中 Turn，先在界面正常停止。
  - 若测试过程中产生了待审批卡片、排队消息或模式切换（如 `Plan`），在界面中取消/清理并将协作模式恢复为 `Chat`。保留本次测试聊天记录与截图证据，不删除历史数据。
  - 关闭本次启动的自动化 Chrome 或对应辅助测试进程，保留用户原有进程；如未启动则如实记录。禁止调用会永久停用 Computer Use 会话的停止接口代替正常收尾。
  - 若任何清理步骤无法完成，必须列出会话名称、当前状态及潜在影响，不得声称清理成功。
- **报告输出**：
  - 使用 UTF-8 编码将完整报告写入 `F:\CodeProject\guardian-lab\src\acceptance-reports\prompt-engineering-<YYYYMMDD-HHmmss>.md`，截图存入 `F:\CodeProject\guardian-lab\src\acceptance-reports\assets\<同一时间戳>\` 并使用相对路径引用。
  - 报告须包含：执行时间、环境与构建确认情况（含限制）、被测会话所选模型与思考强度档位、工作目录与前后 Git 状态对比、逐项结论（通过/失败/未验证）与截图证据、失败项最短复现步骤（如有）、未验证原因、清理结果及新增文件列表。严格区分产品缺陷、被测模型偶发行为与自动化操作干扰，不猜测未经证实的根因。
- **最终回复格式**：任务完成后，最终回复只简要列出关键结论、未验证项、残留风险和报告完整路径。
