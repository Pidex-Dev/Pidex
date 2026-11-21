# Pidex Subagent 命名规范、展示重构与后台状态同步实施计划

> 目标：解决 Pidex 当前把任务描述（`description`）直接塞入 `displayName`、主时间线隐藏子智能体名称与任务标题、右侧面板保留冗余 `<header>` 且存在手动「重试」按钮的问题，并参照 `D:\GitHubProject\Agent\ZCode` 的后台状态同步机制确保主 Agent 始终及时感知后台子智能体的运行、阻塞与终态。

---

## 1. 已对齐的核心设计决策

1. **双字段分离与默认命名规则**：
   - `displayName` 严格存**智能体名字**；新增可选字段 `title` 存**简短任务标题**（来自 `Agent` 工具 `description` 或 `spawn_agents` 的 `title`）。
   - 未显式传入 `name` 时的默认命名优先级：
     1. 显式 `name`（非空字符串）
     2. 非 `general` 的 `role` 映射名：`frontend -> Frontend`、`backend -> Backend`、`devops -> DevOps`、`qa -> QA`、`designer -> Designer`、`data -> Data`、`docs -> Docs`、`product -> Product`
     3. 按 `profile` 映射：`explorer -> Explorer`、`worker -> Worker`、`default -> General Purpose`、`fork -> Context Fork`
   - 历史旧数据兼容（`subagent_tasks.title` 为 `NULL` 时）：UI 展示层将基于 `role` / `profile` 推导智能体名字，并把旧 `display_name` 回退视为任务标题。
2. **主对话时间线展示（`CanonicalThreadView.tsx`）**：
   - 每个 `subagent` item 渲染为紧凑可点击行：`[SubagentAvatar]` + `智能体名` + `任务标题`（含轻量状态反馈），点击直接在右侧打开对应的独立子智能体 Tab。
   - 保留现有 `SubagentAvatar` 9 套像素头像，不替换头像美术资源。
3. **概览面板（`ThreadSummaryPanel.tsx`）**：
   - 「智能体」分区默认展开，收起时沿用现有逻辑（显示最多 3 个头像及 `+N` 数量）；展开后按行展示每一个子智能体（头像 + 任务标题/智能体名 + 已运行时间或状态）。
   - 「停止」按钮直接放在运行中子智能体行右侧；**不提供任何手动「重试」按钮**。
   - 点击整行直接在右侧打开/聚焦该子智能体的独立 Tab。
4. **右侧工作台独立子智能体 Tab（`RightDockState.ts` / `WorkbenchTabRegistry.tsx` / `SubagentThreadPanel.tsx`）**：
   - 新增独立 Tab 类型 `subagent-thread`（`id: subagent-thread:<taskId>`），Tab 图标使用 `SubagentAvatar`，Tab 标题直接显示任务标题。
   - `SubagentThreadPanel` 移除顶部 `<header>`（含返回按钮、标题栏、状态徽章及手动重试按钮），直接展示子智能体对话流；停止操作由概览面板承担。
5. **后台状态同步与主 Agent 主动唤醒（对标 ZCode）**：
   - 不允许人工手动重试子智能体；子智能体在后台运行、阻塞（`waiting-permission` / `waiting-question`）、长时间无进展或结束时，必须及时向主 Agent 同步状态并支持唤醒：
     1. `collaborationMessages` 在每次父模型请求前注入当前线程仍在工作或阻塞的子智能体实时状态快照（含 `taskId`、`displayName`、`title`、`status`、`elapsed`），确保主 Agent 在多步工具循环中随时掌握子智能体动态。
     2. 后台子智能体进入阻塞状态（`waiting-permission` / `waiting-question`）、长时间无进展停滞（参照 ZCode `BackgroundSubagentStallClock`）或进入终态（`completed` / `failed` / `stopped` / `interrupted`）时，通过 `<task-notification>` 及时通知/唤醒主 Agent（兼容 `ParentTurn` 已结束的 idle wake 场景），由主 Agent 决定调用 `send_agent` 唤醒/引导或 `stop_agent` 停止。

---

## 2. 分阶段实施步骤

### Phase 1：共享契约与 SQLite 向前兼容 Schema

1. **`packages/shared/src/thread/Subagent.ts` & `Items.ts`**：
   - `SubagentTaskSchema` 与 `SubagentItemSchema` 新增 `title: Schema.optional(Schema.NullOr(Schema.String))`。
   - 导出辅助函数 `resolveSubagentDisplayParts({ displayName, title, profile, role, task })` 统一处理新旧数据的「智能体名」与「任务标题」解析。
2. **`apps/agent/src/storage/database/Schema.ts` & `SchemaInitializer.ts`**：
   - `SCHEMA_VERSION` 从 `76` 升为 `77`（`HISTORY_APPLICATION_ID = 3` 保持不变）。
   - `subagent_tasks` 新增可空列 `title TEXT`，`SchemaInitializer` 增加 `76 -> 77` 幂等迁移（`PRAGMA table_info` 检查后 `ALTER TABLE subagent_tasks ADD COLUMN title TEXT`）。

### Phase 2：Agent 命名规范、工具 Schema 与后台状态同步

1. **`apps/agent/src/tool/Delegation/Definitions.ts`**：
   - `agentInputSchema` 与 `spawnAgentsInputSchema` 中补充/明确：`name` 为可选智能体名（省略时由宿主按 role/profile 自动命名）；`description` / `title` 为简短任务标题。
2. **`apps/agent/src/orchestration/AgentRuntimeService.ts` & `apps/agent/src/subagent/SubagentService.ts` & `SubagentRepository.ts`**：
   - 停止把 `description` 覆盖写入 `displayName`。新增 `resolveDefaultSubagentName(profile, role, isFork)` 命名器。
   - `SpawnSubagentInput` 与 `SubagentRepository.create` 支持并持久化 `title`（同时兼容 `items` JSON 中的 `title` 字段与 `subagent/created` / `subagent/updated` 事件）。
   - `HandbackFormat.ts` 在 handback header 中同时输出 `name` 与 `title`（若存在）。
3. **后台状态同步与停滞/阻塞唤醒（`SubagentService.ts` & `SubagentCollaborationRepository.ts` & `ThreadService.ts`）**：
   - 在 `ThreadService.ts` 构造 `collaborationMessages` 时合并实时子智能体状态摘要（运行中 / 等待审批或提问 / 最近终态），附带 `taskId`、`displayName`、`title`、`status`。
   - 后台子智能体进入 `waiting-permission` / `waiting-question` 或终态时通过 `backgroundNotifyHandler` / `subagent_background_notifications` 及时投递 `<task-notification>`（并增加后台无进展停滞提醒时钟，防止子智能体静默卡死）。

### Phase 3：Renderer 时间线、概览面板与独立右侧 Tab

1. **`apps/desktop/renderer/src/features/session/timeline/CanonicalThreadView.tsx`**：
   - 将 `subagent` group 渲染为紧凑的逐条可点击行：`[SubagentAvatar] <agentName>  <taskTitle>`（含运行/成功/失败状态指示），点击触发 `onOpenSubagent(item.subagentTaskId)`。
2. **`apps/desktop/renderer/src/features/session/summary/ThreadSummaryViewModel.ts` & `ThreadSummaryPanel.tsx`**：
   - `ThreadSummarySectionId` 新增 `'agents'`，默认展开（不在默认折叠集合内）；收起时保留现有最多 3 个头像与 `+N` 预览。
   - 展开后列出所有子智能体：头像 + 任务标题（附智能体名副标）+ 已运行耗时/状态，运行中/可停止项右侧放「■ 停止」按钮（调用 `desktopClient.stopSubagent`）；点击行打开独立子智能体 Tab。
3. **`RightDockState.ts` / `ConversationUiState.ts` / `WorkbenchTabRegistry.tsx` / `WorkbenchTabStrip.tsx` / `DesktopLayout.tsx` / `SubagentDockContent.tsx` / `SubagentThreadPanel.tsx`**：
   - 在 `WorkbenchTabDescriptor` 中新增 `subagent-thread` 类型：`{ id: 'subagent-thread:${string}', kind: 'subagent-thread', taskId: string, parentThreadId: string, title: string, role?: SubagentRole }`（并兼容旧 `subagent-directory` 持久化状态）。
   - `WorkbenchTabDefinition` 支持基于当前会话状态动态解析 Tab 图标（`<SubagentAvatar size="sm" />`）和最新标题（`<任务标题>`）。
   - `handleOpenSubagent(taskId)` 直接打开/聚焦 `subagent-thread:<taskId>` Tab。
   - `SubagentThreadPanel.tsx` 移除顶部 `<header>` 区域（不显示返回按钮、大标题与手动「重试」按钮）；保留 `SubagentDockContent.tsx` 中必要的运行结果/待审批卡片交互。

### Phase 4：测试与全仓门禁验证

- 补充/更新 `apps/agent/test/` 与 `apps/desktop/renderer/` 相关单元测试（覆盖命名规则、SQLite 74→75 迁移、历史记录回退、后台状态通知、Tab 序列化与概览面板交互）。
- 运行：`bun run --cwd packages/shared typecheck`、`bun run --cwd apps/agent typecheck && bun run --cwd apps/agent test`、`bun run --cwd apps/desktop/renderer typecheck && bun run --cwd apps/desktop/renderer test`、`bun run typecheck`、`bun run arch:check`、`bun run lint:ratchet`、`bun run build:renderer`、`git diff --check`。
