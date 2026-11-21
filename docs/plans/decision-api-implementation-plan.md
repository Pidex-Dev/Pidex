# Pidex 引入 Decision API 与 Judge 决策内核可执行实施计划

> 本计划用于指导在 Pidex（`f:\CodeProject\CodePilotX`）中引入 Decision API、Judge 决策引擎与核心业务决策点（参考 `D:\GitHubProject\Agent\mu`）。
> 执行前请先阅读根目录 [`AGENTS.md`](../../AGENTS.md) 及各子目录 `AGENTS.md`，严格遵守安全、凭据、Schema 向前兼容、RPC v4 唯一性与 Renderer 组件契约。

---

## 0. 执行约束与架构红线（所有执行模型必读）

1. **包与依赖边界**：
   - 禁止新增、合并、删除或重新划分 monorepo workspace。
   - 依赖单向流动：`apps/desktop/renderer -> packages/session-view & packages/agent-protocol & packages/shared -> apps/agent`。
   - `packages/*` 不得依赖 Electron、DOM、React；`apps/agent/src/decision/` 不得依赖 Renderer 或 Electron。
   - 公共 API 仅通过包级 `src/index.ts` 或 `package.json` 中的 `exports` 暴露，禁止跨包 deep import 内部文件。
2. **安全、凭据与权限底线**：
   - **唯一判权链**：严禁绕过 `PermissionDecisionEngine`。`tool.risk` / `tool.approval` / `tool.constraint` 只能作为 `auto-review` 路径下 `ReviewerService` / `GuardianScoreService` 的快速前置/辅助判别，不得降低静态风险下限（`ShellRiskClassifier`）、不得覆盖 Plan/只读模式、不得绕过硬拒绝（`deny`）或 `ask` 规则、不得跳过 `actionHash` / `authorizationVersion` 校验。
   - **三类状态源严格隔离**：
     - `user_message`：仅取宿主记录的真实用户发言（剥离模型自述、工具结果、扩展提示词与仓库 `AGENTS.md`）。
     - `constraint`：取自当前会话确认的硬限制，仅用于收窄允许范围。
     - `fact`：命令文本、路径、模型输出、工具输出、代码 diff，绝不可作为用户授权证据。
   - **凭据隔离**：API Key 绝不可明文写入 `.pidex/config.json`、SQLite、日志、事件或错误消息。OpenAI Provider 的加密凭据仅可发往 `https://api.openai.com`；自定义 `baseUrl` 中继必须使用显式绑定的独立凭据或 `apiKeyEnv`。
   - **写入 Ledger 脱敏**：`decision_ledger` 默认只落盘 `stateDigest`（SHA-256）；仅当 `decision.recordState === true` 时才写入 `state_json` 与 `questions_json`，且写入前必须经 `SecretScrubber` 脱敏。
3. **SQLite 向前兼容基线**：
   - `Schema.ts` 当前 `SCHEMA_VERSION = 74`，`HISTORY_APPLICATION_ID = 3`（**严禁修改 `HISTORY_APPLICATION_ID`**）。
   - 新增 `decision_ledger` 与 `decision_outcomes` 独立表，升级 `SCHEMA_VERSION` 至 `75`，并在 `SchemaInitializer.ts` 提供 `74 -> 75` 幂等迁移（`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`）。
   - 所有写入与 transactional outbox 事件必须复用同一 `RepositoryDatabase` 连接并在同一 SQLite 事务中提交。
4. **注释与代码风格**：
   - 遵循分级注释契约：仅允许导出 API 的 JSDoc 与 `// INVARIANT:` / `// SAFETY:` 注释；禁止普通“what”注释、裸 `@ts-ignore`、`oxlint-disable` 与未追踪 `TODO/FIXME`。
   - Renderer 禁止新增裸 `useEffect`（使用 `UseMountEffect` / `UseExternalSubscription`）；所有动作按钮复用 `components/ui/Button`；不使用 `.scss`。
5. **跳过项**：
   - **明确跳过 `capability.disclosure`**：Pidex 的 `apps/agent/src/prompt/CapabilityCatalog.ts` 使用冻结延迟目录 + `ToolSearch` 按需激活机制，不引入每轮全量重评能力的决策点。
   - **明确跳过 `mude` macOS MLX 进程管理器**：Windows-first 本地模型通过 `systemone` / `http` / `llama-cpp-classify` 端点接入。

---

## 1. Phase 0：共享契约、SQLite 账本与 RPC v4 协议基座

### 1.1 `packages/shared` 新增 Decision 领域模型

- **新建文件**：
  - `packages/shared/src/decision/Types.ts`
  - `packages/shared/src/decision/Manifest.ts`
  - `packages/shared/src/decision/index.ts`
- **修改文件**：
  - `packages/shared/package.json`（在 `exports` 中新增 `"./decision": "./src/decision/index.ts"`）
  - `packages/shared/src/index.ts`（增加 `export * from './decision'`）
- **核心类型定义**：
  - `DecisionMode = 'off' | 'shadow' | 'active'`
  - `CacheImpact = 'none' | 'append-only' | 'prefix-mutating'`
  - `LatencyClass = 'inline' | 'parallel' | 'background'`
  - `DecisionCapability = 'classify' | 'relate' | 'rate' | 'meta' | 'screen' | 'intent'`
  - 问题类型：`BooleanQuestion` / `ChoiceQuestion` / `ScoreQuestion` / `DecisionQuestion`
  - 答案类型：`BooleanAnswer` / `ChoiceAnswer` / `ScoreAnswer` / `DecisionAnswer` / `JudgeUsage` / `JudgeWarning` / `JudgeTierReport`
  - 配置类型：
    - `JudgeType = 'openai' | 'typesafe' | 'systemone' | 'http' | 'classifier' | 'llm' | 'mock'`
    - `JudgeConfig`: `{ type, model?, baseUrl?, path?, apiKeyEnv?, credentialId?, thinking?, timeoutMs?, confidenceThreshold? }`
    - `DecisionConfig`: `{ tiers: string[], judges: Record<string, JudgeConfig>, modes: Record<string, DecisionMode>, routes: Record<string, string[]>, features: Record<string, Record<string, unknown>>, recordState: boolean }`
  - 账本与结果类型：
    - `DecisionLedgerRecord`: `{ id, threadId?, turnId?, specId, specVersion, mode: 'shadow' | 'active', providerId, modelId?, outcome, source: 'judge' | 'fallback', reason?, judged?, answers?, latencyMs?, usage?, warnings?, tiers?, batch?, stateDigest, state?, questions?, createdAt }`
    - `DecisionOutcomeRecord`: `{ id, ledgerId, threadId?, kind: 'permission' | 'mark' | 'nudge', verdict, note?, payload?, createdAt }`
    - `DecisionPresentationNotice`: `{ id, threadId, turnId?, specId, code, params, message, createdAt }`
    - `DecisionPointManifest`: 静态元信息表（`id`, `group: 'input' | 'context' | 'safety' | 'turn' | 'teamwork'`, `title`, `titleZh`, `summary`, `summaryZh`, `defaultMode`, `feature`）。
- **验证**：`bun run --cwd packages/shared typecheck`

### 1.2 `packages/agent-protocol` 新增 RPC v4 契约与能力声明

- **新建文件**：
  - `packages/agent-protocol/src/methods/Decision.ts`
- **修改文件**：
  - `packages/agent-protocol/src/runtime/Capabilities.ts`：新增 `'decision.engine.v1'` 到 `Capabilities` 列表。
  - `packages/agent-protocol/src/methods/index.ts`：导入并合并 `DecisionRpcMethods` 及 `export * from './Decision'`。
  - `packages/agent-protocol/src/wire/Events.ts`：在 `EventManifest` 中新增：
    - `'decision/recorded'`（`durability: 'durable'`, `stream: 'thread'`, `capability: 'decision.engine.v1'`, `reconcilesWith: 'decision/listLedger'`）
    - `'decision/outcomeRecorded'`（`durability: 'durable'`, `stream: 'thread'`, `capability: 'decision.engine.v1'`, `reconcilesWith: 'decision/listLedger'`）
    - `'decision/notice'`（`durability: 'durable'`, `stream: 'thread'`, `capability: 'decision.engine.v1'`）
- **RPC v4 方法清单（`Decision.ts`）**：
  - `decision/getConfig` (`mutation: false`)：params `{ cwd? }`；result `{ config, manifest, effectiveProviders }`
  - `decision/updateConfig` (`mutation: true`)：params `{ scope: 'user' | 'profile' | 'project', cwd?, patch }`；result `{ config, version }`
  - `decision/probe` (`mutation: false`)：params `{ judgeName?: string, cwd? }`；result `{ ok, providerId, modelId?, latencyMs, errorKind? }`
  - `decision/listLedger` (`mutation: false`)：params `{ threadId, turnId?, specId?, limit?, cursor? }`；result `{ records, outcomes, nextCursor? }`
  - `decision/markOutcome` (`mutation: true`)：params `{ ledgerId, threadId, verdict: 'correct' | 'wrong', note? }`；result `{ outcome }`
- **验证**：`bun run --cwd packages/agent-protocol typecheck`

### 1.3 SQLite 独立表与 `DecisionLedgerRepository`（`apps/agent/src/storage`）

- **新建文件**：
  - `apps/agent/src/storage/repositories/DecisionLedgerRepository.ts`
- **修改文件**：
  - `apps/agent/src/storage/database/Schema.ts`：`SCHEMA_VERSION` 从 `74` 升为 `75`（`HISTORY_APPLICATION_ID` 保持 `3` 不变）。
  - `apps/agent/src/storage/database/SchemaInitializer.ts`：
    - 将 `DECISION_LEDGER_SCHEMA` 加入 `FINAL_SCHEMA`。
    - 在 `history` 迁移表中新增 `74: () => ...` 幂等建表与建索引。
  - `apps/agent/src/storage/database/AgentDatabase.ts`：在 `this.repositories` 中挂载 `decisionLedger: new DecisionLedgerRepository(this)`。
- **表结构（向前兼容独立表）**：
  ```sql
  CREATE TABLE decision_ledger (
    id TEXT PRIMARY KEY,
    thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
    turn_id TEXT,
    spec_id TEXT NOT NULL,
    spec_version INTEGER NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('shadow', 'active')),
    provider_id TEXT NOT NULL,
    model_id TEXT,
    outcome_json TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('judge', 'fallback')),
    reason TEXT,
    judged_json TEXT,
    answers_json TEXT,
    latency_ms INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_input_tokens INTEGER,
    cache_write_tokens INTEGER,
    warnings_json TEXT,
    tiers_json TEXT,
    batch_json TEXT,
    state_digest TEXT NOT NULL,
    state_json TEXT,
    questions_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_decision_ledger_thread_created ON decision_ledger(thread_id, created_at DESC);
  CREATE INDEX idx_decision_ledger_spec_created ON decision_ledger(spec_id, created_at DESC);

  CREATE TABLE decision_outcomes (
    id TEXT PRIMARY KEY,
    ledger_id TEXT NOT NULL REFERENCES decision_ledger(id) ON DELETE CASCADE,
    thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('permission', 'mark', 'nudge')),
    verdict TEXT NOT NULL,
    note TEXT,
    payload_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_decision_outcomes_ledger ON decision_outcomes(ledger_id, created_at DESC);
  CREATE INDEX idx_decision_outcomes_thread ON decision_outcomes(thread_id, created_at DESC);
  ```
- **Repository 职责**：
  - 实现 `available()` 防御性列检查（参照 `ThreadGoalLedgerRepository.ts`）。
  - `appendRecord(record)` / `appendOutcome(outcome)` 在事务内写库并调用 `db.insertEvent(...)` 写入 transactional outbox（当 `threadId` 存在时推送 `decision/recorded` 或 `decision/outcomeRecorded`）。
  - `listByThread({ threadId, turnId, specId, limit, cursor })` 返回分页记录与关联 outcomes。

---

## 2. Phase 1：Decision 内核、Judge Providers 与服务装配（`apps/agent/src/decision`）

### 2.1 Decision 内核（参考 `D:\GitHubProject\Agent\mu\packages\kyrn-judge\src\`）

- **新建目录**：`apps/agent/src/decision/`
  - `DecisionErrors.ts`：`JudgeErrorKind` (`'auth' | 'payment_required' | 'rate_limited' | 'bad_request' | 'timeout' | 'aborted' | 'unreachable' | 'server' | 'invalid_response'`) 与 `JudgeError` 类（禁止携带原始 key 或敏感状态）。
  - `DecisionPolicy.ts`：`threeZone(answer, yesAt = 0.8, noAt = 0.2)`、`isEscapeOption(choice)`、`hasEscapeOption(question)`。
  - `DecisionSpec.ts`：`DecisionSpec<In, Qs, Out>`、`ABSTAIN`、`defineDecision(spec)`（强制校验 `version >= 1`、`choice` 至少含一个逃逸选项除非 `allowChoicesWithoutEscape: true`、`score` 至少 2 个 level）、`digestOf(state)`。
  - `Judge.ts`：`JudgeLike`、`Judge` 包装单 Provider，负责 `validateQuestions`、分批（默认 `maxQuestionsPerRequest = 32`）并发请求、`AbortSignal.timeout(timeoutMs)` + `Promise.race` 硬超时、回答完整性与范围校验。
  - `JudgeCascade.ts`：实现多级 `tiers` 级联。按顺序遍历 tier：过滤当前 tier 支持的 `capabilities` 与未定题目，保留确定结果，将不确定或失败题继续交给下一级；记录每级 `JudgeTierReport` 与汇总 `JudgeUsage`。
  - `DecisionEngine.ts`：
    - `decide(spec, input, options)` 与 `decideMany(spec, inputs, options)`。
    - 严格 fail-open：捕获所有 `JudgeError` 与异常并返回 `spec.fallback(input)`，统计 `EngineStats`。
    - 写入 Ledger 前通过 `SecretScrubber` + 已知环境变量/凭据脱敏器过滤 `state` 与 `questions`；仅当 `recordState === true` 时将脱敏后 `state` / `questions` 传给 Ledger。

### 2.2 Judge Providers（`apps/agent/src/decision/providers/`）

- `OpenAIDecisionsJudgeProvider.ts`：
  - 请求 `POST /v1/decisions`（默认 `https://api.openai.com/v1/decisions`，模型 `gpt-6-luna`）。
  - 映射：`boolean -> predicate`（把 `criteria.true/false` 拼入 `instructions`）、`choice -> choice`、`score -> score`。
  - 参数边界预检：1–400 题、choice 2–255 项、score 2–10 级。
  - 凭据解析：优先读取配置绑定的 `credentialId`（经 `EncryptedCredentialStore`）或 `apiKeyEnv`；仅当 `isOpenAIAddress(baseUrl)` 为 true 时，允许回退到 `PiModelService` 的 `openai` 凭据。
- `SystemOneJudgeProvider.ts`：
  - 支持 `typesafe`（Jev / System One）、`systemone`（本地/自托管 System One 服务）与通用 `http`（`{ state, questions } -> { answers }`）。
  - 凭据通过 `credentialId` 或 `apiKeyEnv` 读取；无 Key 且端点为本地回环（`127.0.0.1` / `localhost`）时允许无认证直连。
- `PiClassifierJudgeProvider.ts`：
  - 适配 `@earendil-works/pi-ai` 中 `ClassifierModel`（`typesafe-system-one`、`cloudflare-workers-ai-system-one`、`llama-cpp-classify`），复用 `PiModelService` 解析模型与加密凭据。
- `PiLlmJudgeProvider.ts`：
  - 通过 `PiModelService.getPiModel(ref)` 调用任意 chat 模型（或回退到 `specialized_models.security` / `specialized_models.generation`），使用紧凑 JSON 判别系统提示词（`thinking: off` 优先），解析最外层 JSON 为 `BooleanAnswer` / `ChoiceAnswer` / `ScoreAnswer`。
- `MockJudgeProvider.ts`：测试用确定性 Mock Provider。

### 2.3 配置集成、Service 与 RPC Handler

- **修改 `apps/agent/src/config/ConfigService.ts`**：
  - 将 `'decision'` 加入合法顶层配置键白名单，支持 `.pidex/config.json` 中 `decision` 节的 `user` / `profile` / `project` 分层读取与 key-path 局部写入。
- **新建 `apps/agent/src/decision/DecisionService.ts`**：
  - 持有 `DecisionEngine`、静态 `DECISION_MANIFEST` 注册表与热更新逻辑（监听 `ConfigService` 变更重建 `JudgeCascade`、`routes`、`modes`、`recordState`）。
  - 提供 `probe(judgeName?)`、`getEffectiveConfig(cwd?)`、`updateConfig(...)`、`presentNotice(notice)`（发布 `decision/notice` outbox 事件）。
- **新建 `apps/agent/src/transport/rpc/handlers/Decision.ts`**：实现 `decision/getConfig`、`decision/updateConfig`、`decision/probe`、`decision/listLedger`、`decision/markOutcome`。
- **修改 `apps/agent/src/Bootstrap.ts` 与 `apps/agent/src/transport/rpc/RpcRouter.ts`**：装配 `DecisionService` 并注册 `decisionHandlers`。

---

## 3. Phase 2：第一批核心业务决策点（Safety + Admission + Turn）

在 `apps/agent/src/decision/specs/` 下实现以下 8 个决策点，并在 `DecisionService` 中注册：

| Spec ID                                      | 默认模式                    | `cacheImpact` | `latency`    | 接入位置与核心行为                                                                                                                                                                                                                           |
| :------------------------------------------- | :-------------------------- | :------------ | :----------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool.risk`                                  | `shadow` -> 观察后 `active` | `none`        | `inline`     | 接入 `ReviewerService.ts` / `ShellRiskClassifier.ts`：针对规则命中的风险命令，仅用 `{ command, flag, user_message }` 判断是否由用户明确请求；`fallback` 为 `'confirm'`，只增确认、绝不降低静态风险。                                         |
| `tool.approval`                              | `shadow` -> `active`        | `none`        | `inline`     | 接入 `ReviewerService.ts` / `GuardianScoreService.ts`：在 `auto-review` 且未命中 `forceHumanApproval` / `critical` 静态底线时评估 `{ tool_call, where, task, user_message }`（`needed                                                        | beyond | unrelated | unclear`）；高置信 `needed`（检查类 `>= 0.7`，常规 `>= 0.8`）返回可采纳放行结果并绑定 `actionHash`/`authorizationVersion`；否则回退现有 Guardian 深度审查或人工审批。审批完成后在 `ApprovalService.ts`写入`permission` outcome 对照记录。 |
| `tool.constraint`                            | `shadow` -> `active`        | `none`        | `inline`     | 接入 `ReviewerService.ts` / `ToolExecutor.ts`：核对有副作用工具调用是否违反当前线程用户明确约束（`task.frame` 未启用时读用户显式规则列表）。                                                                                                 |
| `tool.injection`                             | `active`                    | `none`        | `inline`     | 接入 `ToolExecutor.ts` 外部内容工具（`web_fetch`、web search、MCP 工具输出、含外部抓取命令的 shell 输出）：按段分块调用 `decideMany` 检测提示词注入；命中段落在 `active` 模式下替换为单行安全占位并发送 `decision/notice`。                  |
| `tool.description`                           | `active`                    | `none`        | `background` | 接入 `McpRuntimeService.ts` / `ToolExposurePlan.ts`：按 MCP 工具名称 + 描述 SHA-256 缓存检查工具描述是否夹带诱导越权指令；命中则从暴露工具集中剔除并拒绝调用。                                                                               |
| `tool.admission` & `tool.admission.test-log` | `shadow` -> `active`        | `append-only` | `inline`     | 接入 `ToolExecutor.ts` 输出截断/归档前：先折叠重复测试日志段落，再对超长结果按块 `decideMany` 筛选必要片段入上下文，全文通过 `ArtifactService` 落盘并在上下文中附带读取指针。                                                                |
| `turn.continue`                              | `shadow` -> `active`        | `append-only` | `inline`     | 接入 `AgentRuntimeService.ts` 回合结束钩子：检测模型未调工具但承诺“接下来我会执行…”或对已授权工作请求许可（排除删除/推送/发布/不可逆外发），自动注入延续提示（每条用户消息最多 2 次）；下一轮结束写入 `nudge` outcome（`acted` / `ended`）。 |
| `turn.completion`                            | `shadow` -> `active`        | `append-only` | `inline`     | 接入 `AgentRuntimeService.ts` 回合结束钩子：本轮存在代码改动且模型宣告完成、但本轮未执行任何测试/构建/类型检查时，触发一次验证提醒（每轮最多 1 次）。                                                                                        |

> **注意**：`turn.continue` 与 `turn.completion` 的延续逻辑必须兼容 Pidex 现有的 `GoalContinuationCoordinator.ts`（当线程启用了 Goal 模式且即将进入 Goal 结算时，不重复触发 `turn.continue`）。

---

## 4. Phase 3：第二批（Input / Context / Goal）与第三批（Memory / Review / Swarm）

### 4.1 Phase 3A：Input、Context 与 Goal 快速回退

- **Input 组**（接入 `AgentRuntimeService.ts` / 消息入队入口）：
  - `input.preflight`（`latency: inline`）：分类输入复杂度与思考深度提示。
  - `task.frame`（`latency: parallel`）：判别新消息为 `new_task | hard_constraint | correction | subgoal | no_change`，维护线程级轻量任务框架供 `tool.approval` / `tool.constraint` 使用。
  - `input.interjection`（`latency: inline`, `within 1500ms`）：运行中用户插话时，判别立即注入下一步还是等待本轮结束。
- **Context 与 Goal 组**：
  - `context.forget` & `context.compact`：接入 `ContextManager.ts` 与 `ContextCompactionService.ts`，对陈旧工具结果做占位替换与免摘要保留判别。
  - `goal.met`：接入 `GoalVerifier.ts`，仅在配置启用快速 Judge 预判或结构化 LLM 核验不可用时作为辅助判别（不得绕过 Goal 的未交付项检查与预算门禁）。

### 4.2 Phase 3B：Memory、Review 与 Subagent

- **Memory 组**（接入 `MemoryService.ts`）：
  - `memory.capture`、`memory.recall`、`memory.worth`、`memory.merge`、`memory.applied`。
- **Review 与 Subagent 组**：
  - `review.triage`（接入 `apps/agent/src/review/`）：为评审意见补充 P0–P3 分级与改动归因评估。
  - `swarm.routing`（接入 `apps/agent/src/subagent/`）：为未显式指定角色/模型档位的子 Agent 任务挑选角色与推理等级（严禁突破父任务权限上限）。

---

## 5. Phase 4：投影层与 Desktop Renderer 交互界面

### 5.1 `packages/session-view` 投影扩展

- 在 `packages/session-view/src/canonical/` 扩展消息/事件投影，支持将 `'decision/notice'` 与 `'decision/recorded'` 映射为只读视图条目，确保 Renderer 不直接解析原始 wire payload。
- **验证**：`bun run --cwd packages/session-view typecheck`

### 5.2 Desktop Settings → Decision / Judges 设置面板（`apps/desktop/renderer/src/features/settings/`）

- **新建文件**：
  - `apps/desktop/renderer/src/features/settings/DecisionSettings.tsx`
  - `apps/desktop/renderer/src/features/settings/DecisionSettingsModel.ts`
- **修改文件**：
  - `apps/desktop/renderer/src/features/settings/SettingsRegistry.ts`：注册 `decision` 设置页（如放在 `integrations` 或 `coding` 分组，关联 `requires: { capabilities: ['decision.engine.v1'] }`）。
  - `apps/desktop/renderer/src/features/settings/SettingsContentArea.tsx`（或对应路由分发文件）：挂载 `DecisionSettings`。
  - `apps/desktop/renderer/src/services/desktop-client/`：封装 `decision/*` typed client 方法（遵循 `renderer -> typed bridge/Agent client` 单向调用）。
- **UI 功能**：
  - Judge 级联链（`tiers`）排序与增删、Built-in / Custom Judge 配置（OpenAI Decisions、`jev`/System One、`classifier`、`llm`）、一键 `Probe` 测试连通性与延迟展示。
  - 按 5 个分组展示全部已注册决策点，支持切换 `off | shadow | active`、配置单点 `routes` 与 `recordState` 开关（附隐私提示）。

### 5.3 会话工作台 Judge 面板与时间线提示（`apps/desktop/renderer/src/features/layout/dock/` & `session/`）

- **新建文件**：
  - `apps/desktop/renderer/src/features/layout/dock/RightDockJudgePanel.tsx`（或放入 `features/session/` 后在 `RightDockPanels.tsx` 注册）。
  - 时间线 Decision Notice 紧凑渲染组件（在 `features/session/timeline/`）。
- **UI 功能**：
  - 右侧工作台新增 `Judge` 标签页：通过 `decision/listLedger` 与订阅 `decision/recorded` 实时展示当前会话决策记录（决策点、模式、来源 `judge/fallback`、问题概率分布、耗时、级联命中情况、关联的审批结果对照），并提供「判对了 / 判错了」纠偏按钮调用 `decision/markOutcome`。
  - 对话时间线内嵌展示 `DecisionPresentationNotice`（如拦截外部注入内容、折叠归档长输出、自动跟进未完成承诺）。
- **Renderer 规范检查**：
  - 不使用裸 `useEffect`（使用 `UseMountEffect` / `UseExternalSubscription`）。
  - 动作按钮使用 `components/ui/Button`；排版使用 `tw:type-*` + `tw:weight-*`；禁止新增 `.scss`。

---

## 6. 端到端验证与交付门禁（每阶段必跑）

1. **单元测试与 Golden 快照**：
   - `apps/agent/test/decision/DecisionEngine.test.ts`：覆盖 `off` / `shadow` / `active`、`actsInShadow`、超时 fail-open、`ABSTAIN`、脱敏与 `recordState`。
   - `apps/agent/test/decision/JudgeCascade.test.ts`：覆盖能力过滤、不确定升级、多级统计合并。
   - `apps/agent/test/decision/OpenAIDecisionsJudgeProvider.test.ts`：覆盖 `predicate`/`choice`/`score` 请求映射、1–400 题限制、拒答处理、跨站 API Key 隔离。
   - `apps/agent/test/decision/DecisionLedgerRepository.test.ts`：覆盖表创建、Schema 74→75 迁移、outbox 事件同事务提交、线程级联删除。
   - `apps/agent/test/decision/DecisionSpecs.test.ts`：各决策点 Golden 输入与 Policy 断言。
2. **全仓门禁命令**：
   - `bun run --cwd packages/shared typecheck`
   - `bun run --cwd packages/agent-protocol typecheck`
   - `bun run --cwd packages/session-view typecheck`
   - `bun run --cwd apps/agent typecheck && bun run --cwd apps/agent test`
   - `bun run --cwd apps/desktop/renderer typecheck && bun run --cwd apps/desktop/renderer css:check`
   - `bun run typecheck && bun run arch:check && bun run lint:ratchet && bun run build:renderer`
   - `git diff --check`
