# Pidex Decision P0 扩展实施计划（Browser / Instruction & Skill / PR Watch）

> 本计划用于指导在 Pidex（`f:\CodeProject\CodePilotX`）现有 Decision 引擎（`decision.engine.v1`）之上落地第一批 P0 扩展决策点，覆盖浏览器防注入与动作风控、不可信外部指令/Skill 筛查、以及 GitHub PR Watch 唤醒分流。
> 执行前请遵循根目录 [`AGENTS.md`](../../AGENTS.md) 与现有基座计划 [`decision-api-implementation-plan.md`](./decision-api-implementation-plan.md) 中的安全、凭据、协议与代码风格约束。

---

## 0. 范围总览与架构约束

本次 P0 覆盖 4 项能力，仅新增 **3 个 Spec**（浏览器防注入直接复用已有 `tool.injection`），全部归入现有 `safety` 与 `teamwork` 分组，**不改动 RPC v4 协议枚举与 SQLite Schema**。

| 能力 | Spec ID | 分组 | 默认模式 | `cacheImpact` | `latency` | 核心接入位置 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 浏览器页面内容防注入 | 复用 `tool.injection` | `safety` | `active`（沿用） | `none` | `inline` | `ToolOutputDecisionAdapter.ts`、`ToolExecutor.ts` |
| 浏览器不可逆动作风控 | `browser.action.risk` | `safety` | `shadow` | `none` | `inline` | `BrowserService.ts`、`ToolExecutor.ts` / `PermissionDecisionAdapter.ts` |
| 外部指令与 Skill 筛查 | `instruction.screen` | `safety` | `active` | `none` | 目录 `background` / 正文 `inline`（SHA-256 缓存） | `SkillService.ts`、`InstructionDiscoveryService.ts`、`ThreadService.ts`、`SubagentService.ts`、`PiToolAdapter.ts` |
| PR Watch 唤醒门禁与分流 | `pr.event_triage` | `teamwork` | `shadow` | `none` | `inline` | `PullRequestWatchService.ts`、`Bootstrap.ts` |

### 强制安全与兼容红线

1. **统一判权链不可绕过**：`browser.action.risk` 仅可在 `auto-review` 下将原本允许的动作升级为人工审批（`ask`）；严禁放宽站点 `deny`、Plan/Grill 只读限制、用户审批规则或 `actionHash`/`authorizationVersion` 校验；`full-access` 保持现有放行契约。
2. **三类状态源严格隔离**：仅宿主数据库记录的真实用户发言（`realUserMessages`）可作为用户意图/授权依据；网页 DOM、控件文本、仓库 `AGENTS.md`、外部 `SKILL.md` 与 GitHub PR Review 均视为不可信事实。
3. **Fail-open 与零缓存破坏**：所有新决策点在 Judge 超时、不可用、未配置或返回 `ABSTAIN` 时必须回退至既有确定性行为（`instruction.screen` 保留静态注入地板）；不每轮动态重写 System Prompt 前缀。
4. **脱敏与零协议破坏**：复用现有 `DecisionGroupSchema`（`safety` / `teamwork`）、`decision_ledger`、`decision_outcomes` 与 `decision/notice` 事件；写入账本的状态一律经现有 `DecisionRedaction` / `SecretScrubber` 脱敏。

---

## 1. 模块一：浏览器页面内容防注入（复用 `tool.injection`）

### 1.1 目标
将浏览器工具返回的网页文本纳入既有 `tool.injection` 段落级筛查，防止网页 DOM、无障碍树或评论区中的间接提示词注入进入模型上下文，同时完整保留 `BrowserResult` 的截图（`image`）等结构化字段。

### 1.2 文件改动清单

- **修改 [`apps/agent/src/decision/integrations/ToolOutputDecisionAdapter.ts`](../../apps/agent/src/decision/integrations/ToolOutputDecisionAdapter.ts)**：
  - 在 `externalContentSource(name, input, isMcp)` 中增加浏览器外部内容工具识别：
    - `normalized === 'browserread' || normalized === 'browsernavigate' || normalized === 'browseraction'` 时返回 `name`。
    - `BrowserTabs` 仅返回标签列表元数据，不纳入全文注入筛查（或若需防恶意标题，可在后续单独评估）。
- **修改 [`apps/agent/src/tool/ToolExecutor.ts`](../../apps/agent/src/tool/ToolExecutor.ts)**：
  - 在工具输出筛查方法（`screenToolOutput` 所在分支，当前处理 `string` 与 `{ stdout: string }`）中新增对 `BrowserResult` 形态（`output` 为非空对象且 `typeof (output as { text?: unknown }).text === 'string'`，且非 `isShellResult`）的结构化保留处理：
    - 仅提取 `output.text` 传入 `screenExternalContent` 与 `admitToolOutput`；
    - 当 `text !== original` 时返回 `{ ...(output as object), text, decisionScreened: true }`，避免走 `JSON.stringify(output)` 覆盖导致 `Browser/Definition.ts` 的 `formatResult` 丢失 `result.text` 与 `result.image`。

---

## 2. 模块二：浏览器不可逆动作风控（`browser.action.risk`）

### 2.1 目标
弥补 `BrowserService.inspect` 当前仅按站点 `origin` 授权的粒度盲区：在 `auto-review` 模式下，对同一已授权站点中可能产生不可逆外部副作用的交互动作进行快速判别，命中且非用户明确要求时升级为人工审批。

### 2.2 `BrowserService` 轻量元素语义缓存
- **修改 [`apps/agent/src/browser/BrowserService.ts`](../../apps/agent/src/browser/BrowserService.ts)**：
  - 在内存中维护按 `(tabId, documentId)` 索引的轻量 LRU 映射（上限如 64 份文档，不落盘，标签关闭或 `documentId` 变更时自动失效）：
    - 当 `BrowserRead` 的 `snapshot` 完成返回 `result.text` 时，解析包含 `[ref=...]` 的无障碍树行，建立 `ref -> elementSummary`（截断至单行 ≤ 300 字符）。
  - 提供只读查询方法 `describeActionTarget(tabId: string, operation: BrowserOperation): { url: string | null; title: string | null; targetText: string | null }`，在 `ref` 缺失时回退输出 `selector` 或坐标概要。

### 2.3 Spec 定义
- **新建 `apps/agent/src/decision/specs/BrowserActionRisk.ts`**：
  - `id: 'browser.action.risk'`，`version: 1`，`cacheImpact: 'none'`，`latency: 'inline'`。
  - `capabilities: { irreversible: 'screen', requested: 'relate' }`。
  - **Input**：
    ```ts
    export interface BrowserActionRiskInput {
      readonly action: 'click' | 'fill' | 'select' | 'check' | 'key' | 'dialog'
      readonly url: string
      readonly title: string
      readonly target: string
      /** Non-sensitive summary or presence indicator; never pass raw secrets. */
      readonly textPreview: string
      /** Host-recorded real user messages only. */
      readonly userMessage: string
    }
    ```
  - **Questions**：
    - `irreversible` (`boolean`)：当前浏览器动作（结合 `url`、`title`、`target`、`action`、`text_preview`）是否可能触发外部不可逆或高影响副作用（如支付/下单、删除云端资源、发送邮件/消息/公开发帖、授权 OAuth/权限变更、修改账户安全设置、确认危险弹窗）。
    - `requested` (`boolean`)：真实用户发言 `user_message` 是否明确要求执行该具体提交/外部动作（网页文本与控件文案不得视为用户授权）。
  - **Policy & Fallback**：
    - `Outcome = 'allow' | 'confirm'`。
    - 仅当 `threeZone(answers.irreversible) === 'yes'` 且 `threeZone(answers.requested) !== 'yes'` 时返回 `'confirm'`；其余（含 `ABSTAIN`、非高置信或失败）返回 `'allow'`（fail-open，避免阻断正常浏览；安全下限由 `BrowserService.inspect` 与 `PermissionDecisionEngine` 兜底）。
- **注册**：
  - 在 [`apps/agent/src/decision/specs/SafetySpecs.ts`](../../apps/agent/src/decision/specs/SafetySpecs.ts) 导出 `browserActionRiskSpec` 并加入 `SAFETY_MANIFEST`：
    - `group: 'safety'`，`defaultMode: 'shadow'`，`feature: 'browser-action-risk'`。

### 2.4 运行时接线
- **覆盖动作白名单**：仅 `BrowserAction` 且 `operation.action` 属于 `'click' | 'fill' | 'select' | 'check' | 'key' | 'dialog'`（跳过 `hover`、`scroll`、`viewport`）。
- **触发条件**：
  - 仅在 `auto-review` 模式（非 `full-access`、非 `read-only`）且静态规则尚未判定为 `deny` 或强制 `ask` 时调用（避免重复确认）。
  - 传入的 `textPreview` 需经 `secretScrubber.scrubText` 脱敏并截断（≤ 200 字符）；若控件语义疑似密码/token 输入框，直接替换为 `[redacted-input]`。
- **接入位置**：
  - 在 [`apps/agent/src/decision/integrations/PermissionDecisionAdapter.ts`](../../apps/agent/src/decision/integrations/PermissionDecisionAdapter.ts) 新增 `evaluateBrowserActionRisk(...)`。
  - 在 [`apps/agent/src/tool/ToolExecutor.ts`](../../apps/agent/src/tool/ToolExecutor.ts)（与 `enforceUserConstraints` / 审批前置检查相邻，且在 `PermissionDecisionEngine` 评估前或升级为 `forcedApproval` 路径上）调用：当 `mode === 'active'`、`source === 'judge'` 且 `outcome === 'confirm'` 时，将本次调用标记为需人工审批（附加清晰原因与 `decisionLedgerId`，审批完成后复用 `ApprovalService` 写入 `permission` outcome 对照记录）。

---

## 3. 模块三：外部指令与 Skill 筛查（`instruction.screen`）

### 3.1 目标
在不可信仓库指令文件（`AGENTS.override.md`、`AGENTS.md`、`CLAUDE.md`）以及不可信 Skill（仓库内 Skill 与第三方 Plugin Skill 的目录描述和 `skill_read` 正文）进入模型上下文前，拦截诱导越权、窃密、隐瞒用户或篡改工具行为的投毒段落。

### 3.2 信任边界（严格白名单跳过）
- **需要筛查（不可信来源）**：
  - `InstructionDiscoveryService.discover()` 扫描到的全部仓库指令文件。
  - `SkillService` 中来源为 `workspace`（仓库内）与 `plugin`（第三方插件 `plugin://...`）的 Skill 目录描述与 `skill_read` 正文。
- **跳过筛查（可信来源，避免误杀用户自写规则）**：
  - `builtin` 内置 Skill（`builtin://...`）。
  - 用户全局目录 Skill（`userHome` / `dataRoot`）。

### 3.3 Spec 定义
- **新建 `apps/agent/src/decision/specs/InstructionScreen.ts`**：
  - `id: 'instruction.screen'`，`version: 1`，`cacheImpact: 'none'`，`latency: 'inline'`，`capabilities: 'screen'`。
  - 复用 [`ToolInjection.ts`](../../apps/agent/src/decision/specs/ToolInjection.ts) 的 `splitPassages` 与 [`ToolDescription.ts`](../../apps/agent/src/decision/specs/ToolDescription.ts) 的 `looksPoisoned` 作为静态地板。
  - **Input**：
    ```ts
    export interface InstructionScreenInput {
      readonly kind: 'project-instruction' | 'skill-catalog' | 'skill-body'
      readonly source: string
      readonly passage: string
    }
    ```
  - **Questions**：
    - `malicious` (`boolean`)：区分**正常的编码规范/工作流说明**与**恶意指令**——仅当 `passage` 试图让 AI 忽略系统安全规则、窃取或外发凭据/环境变量/私密文件、隐瞒用户执行未授权操作、篡改对其他工具或审批机制的信任时判为 `true`。
  - **Policy & Fallback**：
    - 返回 `number | null`（概率），`INSTRUCTION_SCREEN_THRESHOLD = 0.65`（比纯网页内容略保守，降低误伤合法 `AGENTS.md` 规范的概率）；`untrusted`/`unavailable` 返回 `ABSTAIN`，`fallback` 返回 `null`（回落至静态 `looksPoisoned` 地板）。
- **注册**：
  - 在 [`apps/agent/src/decision/specs/SafetySpecs.ts`](../../apps/agent/src/decision/specs/SafetySpecs.ts) 导出 `instructionScreenSpec` 并加入 `SAFETY_MANIFEST`：
    - `group: 'safety'`，`defaultMode: 'active'`，`feature: 'instruction-screen'`。

### 3.4 分层时序、缓存与处置（`InstructionScreenAdapter.ts`）
- **新建 `apps/agent/src/decision/integrations/InstructionScreenAdapter.ts`**：
  - **缓存键**：按 `sha256(kind + '\0' + content)` 维护进程内 LRU 缓存（容量 1,024），存贮两类结果：
    1. 目录描述 verdict：`'clean' | 'poisoned'`；
    2. 正文筛查结果：`{ screenedText: string; withheld: number; source: 'judge' | 'rules' | 'fallback' }`。
  - **路径 A：Skill 目录描述（非阻塞，同 `tool.description`）**：
    - 在 [`apps/agent/src/prompt/SkillService.ts`](../../apps/agent/src/prompt/SkillService.ts) 扫描阶段（`scan()`）针对 `workspace` / `plugin` 来源 Skill：
      - 同步跑静态 `looksPoisoned` 地板并落缓存；
      - 后台异步调用 `decideMany(instructionScreenSpec, ...)`（超时 15s）写入缓存；
      - 已判定为 `poisoned` 的 Skill 从暴露给 `skills.catalog` 的列表中剔除，若绑定 `threadId` 则发送 `decision/notice`。
  - **路径 B：`AGENTS.md`/`CLAUDE.md` 与 `skill_read` 正文（首次同步 `inline` + 缓存命中 0 延迟）**：
    - 按 `splitPassages(content, 2_000)` 分段（上限 24 段），缓存未命中时调用 `decideMany`（单次硬超时 4,000ms，超时 fail-open 回落静态地板）；
    - 仅将命中段落（`probability > INSTRUCTION_SCREEN_THRESHOLD || looksPoisoned(passage)`）替换为单行占位：
      `[pidex 已拦截此段 ${chars} 字符的外部指令：检测到疑似越权或注入内容]`，完整保留其余合法规范段落；
    - 有段落被拦截时，在存在 `threadId` 的上下文中发送 `decision/notice` 通知用户（说明来源文件与拦截段数）。
  - **接入调用点**：
    - 项目指令发现：[`apps/agent/src/session/ThreadService.ts`](../../apps/agent/src/session/ThreadService.ts) 与 [`apps/agent/src/subagent/SubagentService.ts`](../../apps/agent/src/subagent/SubagentService.ts) 在拿到 `InstructionDiscoveryService.discover(...)` 结果后、拼入 Prompt 前调用 `screenProjectInstructions(...)`。
    - Skill 正文读取：[`apps/agent/src/prompt/SkillService.ts`](../../apps/agent/src/prompt/SkillService.ts) 的 `skill_read`（及 [`apps/agent/src/orchestration/pi/PiToolAdapter.ts`](../../apps/agent/src/orchestration/pi/PiToolAdapter.ts) 中 `skill_read` 入口）以及 `$skill` 显式选中加载路径，对非 `builtin`/非用户全局来源的正文调用 `screenSkillBody(...)`。

---

## 4. 模块四：PR Watch 唤醒门禁与评论分流（`pr.event_triage`）

### 4.1 目标
在 [`apps/agent/src/github/PullRequestWatchService.ts`](../../apps/agent/src/github/PullRequestWatchService.ts) 轮询发现 `CHANGES_REQUESTED` 或 `CI FAILURE/ERROR` 变更时，先通过低延迟 Decision 模型做三路分流，避免为无关讨论、重复噪声或需要人工拍板的问题拉起完整主模型 Turn，并对进入修复 Prompt 的外部 Review 文本做防注入筛查。

### 4.2 Spec 定义
- **新建 `apps/agent/src/decision/specs/PrEventTriage.ts`**（或在 [`TeamworkSpecs.ts`](../../apps/agent/src/decision/specs/TeamworkSpecs.ts) 统一导出注册）：
  - `id: 'pr.event_triage'`，`version: 1`，`cacheImpact: 'none'`，`latency: 'inline'`，`capabilities: 'classify'`。
  - **Input**：
    ```ts
    export interface PrEventTriageInput {
      readonly prUrl: string
      readonly headSha: string
      readonly hasFailedChecks: boolean
      readonly failedChecks: readonly { name: string; conclusion?: string; summary?: string }[]
      readonly changeRequests: readonly { id: string; body: string; submittedAt?: string | null }[]
      readonly userInstructions: string
    }
    ```
  - **Questions**：
    - `route` (`choice`)，含显式逃逸项 `unclear`：
      - `actionable_fix`：存在明确可由代码修改解决的 CI 失败（编译/类型/单测/Lint 报错）或具体的代码修改要求。
      - `needs_human`：需要人工决策、产品确认、外部权限/凭据/基础设施处理、或审阅者要求人工回复而非直接改代码。
      - `skip_noise`：仅有无实质改动请求的客套/重复提醒/纯 bot 噪声，且无真实需修代码失败。
      - `unclear`：信息不足以安全跳过，应回退到默认自动修复。
  - **Policy & Fallback**：
    - 仅当 `choice !== 'unclear'` 且置信度（或该选项概率）达到 `>= 0.75` 时采纳 `actionable_fix | needs_human | skip_noise`；否则返回 `unclear`（`fallback` 同为 `unclear`）。
- **注册**：
  - 加入 `TEAMWORK_MANIFEST`（[`apps/agent/src/decision/specs/TeamworkSpecs.ts`](../../apps/agent/src/decision/specs/TeamworkSpecs.ts)）：
    - `group: 'teamwork'`，`defaultMode: 'shadow'`，`feature: 'pr-event-triage'`。

### 4.3 宿主状态机接线
- **新建 `apps/agent/src/decision/integrations/PrWatchDecisionAdapter.ts`**：
  - 导出 `triagePrWatchEvent(decisions, input, options)` 与 `screenPrReviewTexts(decisions, input, options)`（复用 `screenExternalContent` / `tool.injection`）。
- **修改 [`apps/agent/src/github/PullRequestWatchService.ts`](../../apps/agent/src/github/PullRequestWatchService.ts)** 与 [`apps/agent/src/Bootstrap.ts`](../../apps/agent/src/Bootstrap.ts)：
  - 为 `PullRequestWatchService` 增加可选 `decisions?: DecisionService` 依赖（或在 `Bootstrap.ts` 构造时注入 `decisions`）。
  - 在 `PullRequestWatchService.run()` 中，算出 `current` 指纹并确认 `(!failed && !reviews.length) || watch.fingerprint === current` 未命中后、执行 `pr_watch_sync` 与 `executor.start` 之前：
    1. 调用 `triagePrWatchEvent`（origin 关联 `watch.thread_id`）。
    2. 仅在 `decision.mode === 'active' && decision.source === 'judge'` 时按结果分流（`shadow` / `off` / `unclear` / `actionable_fix` 均继续走修复流程）：
       - **`needs_human`**：
         - 更新 `pr_watches` 的 `fingerprint = current`、`head_sha = pr.headRefOid`；
         - 绑定本次 `run.id`（`turnId: null`），调用 `this.stop(watch.id)` 并写入明确 `reason`（如“PR 变更需要人工决策或外部处理，已暂停自动修复”）；
         - 发布 `decision/notice` 到 `watch.thread_id`，返回 `null`（不拉起 Agent Turn）。
       - **`skip_noise`**：
         - 更新 `pr_watches` 的 `fingerprint = current`、`head_sha = pr.headRefOid`（防止 5 分钟后对同一事件重复判别）；
         - 绑定本次 `run.id`（`turnId: null`），发布 `decision/notice` 到 `watch.thread_id`，**保持监控活跃**并返回 `null`。
       - **`actionable_fix` 或 `unclear` / `shadow`**：
         - 在拼接唤醒 Prompt 前，对 `reviews` 的 `body` 字段经 `screenExternalContent`（复用 `tool.injection`，source 标为 `pr_watch:review`）做防注入清洗，避免恶意 PR 评论劫持修复 Agent；
         - 正常执行 `pr_watch_sync` + `executor.start(...)`。

---

## 5. 测试与验证计划

### 5.1 新增与补充单元测试（`apps/agent/test/decision/`）
1. **Browser 防注入测试**（扩充 `SafetyIntegration.test.ts` / `SafetyExecutor.test.ts`）：
   - `externalContentSource` 识别 `BrowserRead` / `BrowserAction` / `BrowserNavigate`，排除无关工具；
   - `ToolExecutor` 对 `{ text, image }` 形态的 `BrowserResult` 拦截注入段落后，完整保留 `image` 字段且替换后 `text` 生效。
2. **`browser.action.risk` 测试**（新建 `BrowserActionRisk.test.ts`）：
   - Spec 契约校验（`irreversible=true & requested=false -> confirm`；用户明确要求或 `ABSTAIN` -> `allow`）；
   - `BrowserService` 的 `snapshot` `ref` 语义索引建立、查询与 `documentId` 失效；
   - 权限边界测试：`full-access` 不触发降级/额外拦截，`auto-review` 下高危动作升级人工审批，`hover`/`scroll` 不调用 Judge。
3. **`instruction.screen` 测试**（新建 `InstructionScreen.test.ts`）：
   - 信任边界测试：`builtin` 与用户全局 Skill 跳过筛查；仓库 `AGENTS.md`、仓库 Skill、第三方 Plugin Skill 进入筛查；
   - 缓存命中测试：同内容 SHA-256 第二次 0 次调用 Judge；
   - 分层处置测试：Skill 目录命中则从暴露列表剔除；正文命中仅替换恶意段落并发送 `decision/notice`，保留合法规范段落；Judge 超时回落静态地板。
4. **`pr.event_triage` 测试**（新建 `PrEventTriage.test.ts`）：
   - Spec 阈值与 `unclear` 回退；
   - `PullRequestWatchService.run()` 三路分流：`actionable_fix` 唤醒且清洗 review 注入文本；`needs_human` 暂停监控并写 `reason`；`skip_noise` 更新 `fingerprint` 不暂停也不唤醒；`shadow` 模式照常唤醒并记账本。
5. **Manifest 与配置一致性测试**：
   - 更新 `Phase3Manifest.test.ts`（或新增 `DecisionP0Manifest.test.ts`），验证新 Spec 在 `DecisionService` 注册表中可见、分组与 `defaultMode` 正确，Settings 页面可无需改代码自动渲染。

### 5.2 交付前验证命令
按 [`AGENTS.md`](../../AGENTS.md) 执行最小充分验证：
1. `bun test apps/agent/test/decision/`（及受影响的 browser / prompt / github 单测）
2. `bun run --cwd apps/agent typecheck`
3. 若涉及 `packages/` 或跨 workspace 导出检查，补充 `bun run typecheck`
4. `bun run arch:check` 与 `git diff --check`
