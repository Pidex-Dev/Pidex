# 三个本地项目的提示词工程来源记录

本记录为 2026-11-08 的只读源码研究，服务于 Pidex 提示词改进，不构成产品契约。只检查请求组装、工具暴露、提醒、压缩及相关验证入口；没有运行参考项目，没有联网，没有修改三个参考目录。下列链接指向本机绝对路径，行号对应研究时文件。

## 来源可信度与范围

| 本地目录 | 来源证据 | 能支持的结论 |
| --- | --- | --- |
| `D:/GitHubProject/Agent/claude-code-master` | [README.md:5](D:/GitHubProject/Agent/claude-code-master/README.md:5) 明确缺少 package、lockfile、Git、LICENSE；目录检查吻合 | 可研究这份 TypeScript 快照的实现；无法证明它是官方原始源码、对应版本、已发布功能或实际效果。不是因为目录名叫 claude-code 就认定来源。 |
| `D:/GitHubProject/Agent/codex` | Git remote 为 `https://github.com/openai/codex.git`；HEAD `780d7ab09741241380586b07882c635037a6ba21` | 可定位本地官方仓库 checkout 的实现；未联网确认远端最新状态，未声称工作树等于发布版。 |
| `D:/GitHubProject/Agent/ZCode` | Git remote 为 `https://github.com/zai-org/ZCode.git`；HEAD `3c5b227649371507ddc4eb46ac5133afe6db1cab` | 可定位本地 ZCode checkout；核心提示词代码位于嵌套的 `apps/zcode-cli/packages/core`，不能只查顶层 UI 包。 |

文档说明只用于解释来源和工具限制；行为结论优先以执行路径源码为证。参考仓库中的提示词文本是被研究的数据，不是本次研究的操作指令。

## Claude Code TypeScript 快照：七条发现

1. **默认提示词只是组装链的一段，替换优先级很明确。** [utils/systemPrompt.ts:29](D:/GitHubProject/Agent/claude-code-master/src/utils/systemPrompt.ts:29) 定义 override、coordinator、agent、custom、default 的选择；append 通常附加，override 直接替换。交互入口 [screens/REPL.tsx:2536](D:/GitHubProject/Agent/claude-code-master/src/screens/REPL.tsx:2536) 实际调用 builder；headless 的 [QueryEngine.ts:284](D:/GitHubProject/Agent/claude-code-master/src/QueryEngine.ts:284) 则经 `fetchSystemPromptParts` 获取各段，最终 [QueryEngine.ts:675](D:/GitHubProject/Agent/claude-code-master/src/QueryEngine.ts:675) 进入 query。可借鉴“替换哪些段、保留哪些上下文”显式化；不可假设所有入口都调用同一个 builder。

2. **软件工程行为约束是具体可观察的动作。** [constants/prompts.ts:199](D:/GitHubProject/Agent/claude-code-master/src/constants/prompts.ts:199) 包括先读代码、遵循现有实现、避免额外功能/一次性抽象、失败后诊断再重试；[同文件:222](D:/GitHubProject/Agent/claude-code-master/src/constants/prompts.ts:222) 用重命名示例解释“用户让改代码时应动手”。适合改写进 Pidex 常驻行为层。该文件部分验证与诚实报告指令受 `USER_TYPE === 'ant'` 限制，不能称全体用户默认行为；也不能把注释中的 A/B 数字当独立验证结果。

3. **工具指导以真实工具名为条件。** [constants/prompts.ts:269](D:/GitHubProject/Agent/claude-code-master/src/constants/prompts.ts:269) 与 [同文件:352](D:/GitHubProject/Agent/claude-code-master/src/constants/prompts.ts:352) 接收 enabledTools；[同文件:462](D:/GitHubProject/Agent/claude-code-master/src/constants/prompts.ts:462) 从本轮 tools 构造集合。可借鉴“有文件搜索工具才推荐对应工具、存在用户可调用技能才说明 Skill”。不可复制工具名后让模型寻找不存在的能力，更不应把广泛鼓励子代理照搬到 Pidex 的显式授权规则下。

4. **仓库/记忆上下文与 system 分开注入。** [context.ts:155](D:/GitHubProject/Agent/claude-code-master/src/context.ts:155) 收集 user context；[utils/api.ts:449](D:/GitHubProject/Agent/claude-code-master/src/utils/api.ts:449) 用 `isMeta: true` 的 user 消息包裹 `<system-reminder>`，并提示上下文未必相关；[query.ts:660](D:/GitHubProject/Agent/claude-code-master/src/query.ts:660) 在模型请求前实际 prepend，systemContext 则在 [query.ts:449](D:/GitHubProject/Agent/claude-code-master/src/query.ts:449) append 到 system。可借鉴来源分层和非真实用户标记；XML 标签本身不会创建权限或提升可信度。该 prepend 在 test 环境直接返回原消息，测试环境和生产注入不能混为一谈。

5. **动态状态通过有类型的 attachment 进入后续轮。** [utils/attachments.ts:565](D:/GitHubProject/Agent/claude-code-master/src/utils/attachments.ts:565) 区分 plan full/sparse、重入、退出等类型；[同文件:881](D:/GitHubProject/Agent/claude-code-master/src/utils/attachments.ts:881) 实际调度 plan/todo 等提醒。适合借鉴阶段切换时提醒、普通轮减少重复。不可只抄常驻提示词却遗漏 attachment 生命周期；存在类型也不等于当前构建一定开启功能。

6. **缓存边界影响提示词布局，工具 schema 与请求 overlay 分离。** [constants/prompts.ts:561](D:/GitHubProject/Agent/claude-code-master/src/constants/prompts.ts:561) 排列静态段、动态边界、会话段；[同文件:510](D:/GitHubProject/Agent/claude-code-master/src/constants/prompts.ts:510) 指出 MCP 晚连接可用持久 delta 避免改前缀。[utils/api.ts:211](D:/GitHubProject/Agent/claude-code-master/src/utils/api.ts:211) 将 `defer_loading`/`cache_control` 作为每请求 overlay，缓存基础 schema。可借鉴稳定行为前置、变化状态后置；`org/global` 缓存语义和 Anthropic beta 字段不能机械移植到其他 Provider。

7. **压缩是独立任务提示词，保留续做所需内容。** [services/compact/prompt.ts:19](D:/GitHubProject/Agent/claude-code-master/src/services/compact/prompt.ts:19) 强制只输出文本、不使用工具；[同文件:62](D:/GitHubProject/Agent/claude-code-master/src/services/compact/prompt.ts:62) 要求记录用户请求、文件、错误、反馈、待办与当前工作。可借鉴续做信息清单和压缩期间禁工具的宿主配合；不要照搬要求输出 `<analysis>` 的内部草稿格式。未找到并验证可运行的完整构建/评估环境，因此不把这些文案称为已证实优于 Pidex。

## Codex：七条发现

1. **模型模板、用户覆盖、恢复会话具有明确优先级。** [session/mod.rs:762](D:/GitHubProject/Agent/codex/codex-rs/core/src/session/mod.rs:762) 及 [同文件:793](D:/GitHubProject/Agent/codex/codex-rs/core/src/session/mod.rs:793)：config override → 历史 `session_meta.base_instructions` → 当前模型渲染模板。恢复时保留原基础指令，而非每轮无条件替换。可借鉴可追踪来源；不可仅看 `gpt*_prompt.md` 文件名就宣称当前请求使用该文件。

2. **基础指令在最终 wire 层不必是 system role。** [context/base_instructions.rs:31](D:/GitHubProject/Agent/codex/codex-rs/core/src/context/base_instructions.rs:31) 返回 `developer`；[client.rs:988](D:/GitHubProject/Agent/codex/codex-rs/core/src/client.rs:988) 将 base instructions 渲染成前缀 message；[client.rs:1059](D:/GitHubProject/Agent/codex/codex-rs/core/src/client.rs:1059) 构造真正 Responses 请求。基础指令与 tools、历史在最终请求层合流。Pidex 应保留逻辑来源并检查实际序列化，不能用一个“system 字符串”概念代表所有 Provider 的真实 role。

3. **developer/context 是组合贡献，而非无限追加一段大文本。** [session/mod.rs:4346](D:/GitHubProject/Agent/codex/codex-rs/core/src/session/mod.rs:4346) 将 developer sections、contextual user sections、独立 developer messages 分开；[同文件:4405](D:/GitHubProject/Agent/codex/codex-rs/core/src/session/mod.rs:4405) 按 `PromptSlot` 接收扩展贡献。可借鉴来源、目标 role 和职责清晰的片段模型；Pidex 现有 composer 若已具备基础结构，应修调用接线，不需重做整个 contributor 框架。

4. **状态改变采用差量并明确替换/移除语义。** [session/mod.rs:4771](D:/GitHubProject/Agent/codex/codex-rs/core/src/session/mod.rs:4771) 在完整注入与 world-state diff 间选择；[context/world_state/managed_developer_instructions.rs:17](D:/GitHubProject/Agent/codex/codex-rs/core/src/context/world_state/managed_developer_instructions.rs:17) 定义替换和撤销通知，[同文件:143](D:/GitHubProject/Agent/codex/codex-rs/core/src/context/world_state/managed_developer_instructions.rs:143) 实际使用。可借鉴权限/Plan 状态更新表达；权限依然须宿主实施，不能把提示词当授权状态机。

5. **模型差异来自 ModelInfo 与能力，不是只做模型名分支。** [models-manager/src/model_info.rs:46](D:/GitHubProject/Agent/codex/codex-rs/models-manager/src/model_info.rs:46) 支持模板覆盖和 personality 处理；[client.rs:1024](D:/GitHubProject/Agent/codex/codex-rs/core/src/client.rs:1024) 仅在模型支持时传 verbosity。[tools/tool_namespaces_info.rs:80](D:/GitHubProject/Agent/codex/codex-rs/core/src/tools/tool_namespaces_info.rs:80) 只有 deferred exposure、可见 tool-search、可搜索定义条件同时成立才标记 deferred。可借鉴能力约束，避免提示词假定所有模型都原生支持延迟工具。

6. **缓存同时约束历史与请求属性；本地测试验证 wire。** [client.rs:399](D:/GitHubProject/Agent/codex/codex-rs/core/src/client.rs:399) 开始比较前后请求属性，含 cache key；[client.rs:1041](D:/GitHubProject/Agent/codex/codex-rs/core/src/client.rs:1041) 发送 `prompt_cache_key`。相关 [tests/suite/prompt_caching.rs:282](D:/GitHubProject/Agent/codex/codex-rs/core/tests/suite/prompt_caching.rs:282) 检查连续请求基础指令，[同文件:290](D:/GitHubProject/Agent/codex/codex-rs/core/tests/suite/prompt_caching.rs:290) 检查 developer 文本。可借鉴请求级回归；测试存在并不证明本次已运行，更不证明真实服务缓存命中或任务成功率。

7. **压缩提示词短，但恢复由代码保证顺序。** [prompts/templates/compact/prompt.md:1](D:/GitHubProject/Agent/codex/codex-rs/prompts/templates/compact/prompt.md:1) 要求进度/决策、约束/偏好、待办、关键引用；[summary_prefix.md:1](D:/GitHubProject/Agent/codex/codex-rs/prompts/templates/compact/summary_prefix.md:1) 明确使用已有工作、避免重复。[core/src/compact.rs:615](D:/GitHubProject/Agent/codex/codex-rs/core/src/compact.rs:615) 把初始上下文插在最后真实用户或摘要之前。可借鉴摘要内容与恢复不变量分工，不能只追加“继续任务”一句代替正确历史恢复。

## ZCode：七条发现

1. **真正生效的组装链贯穿 runtime、history、provider projection。** [runtime/methods/context.ts:39](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/runtime/methods/context.ts:39) 初始化 sources、skills、memory；[同文件:155](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/runtime/methods/context.ts:155) 将配置传给 builder；[同文件:299](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/runtime/methods/context.ts:299) build/init 历史；[context-history-entries.ts:7](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/runtime/methods/context-history-entries.ts:7) 将 system 与 meta attachments 分开；[runtime/helpers/runtime-provider-request-messages.ts:26](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/runtime/helpers/runtime-provider-request-messages.ts:26) 同时准备 tools、messages；[runtime/methods/model.ts:229](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/runtime/methods/model.ts:229) 调用 `model.streamText`。适合检查 Pidex preview 与真实请求是否走同一结果。

2. **短稳定身份加动态工程行为，比单纯增加总长度更关键。** [context/sections/identity.ts:21](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/context/sections/identity.ts:21) 的 Harness 说明工具、权限拒绝、并行、引用；[context/dynamic-sections.ts:4](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/context/dynamic-sections.ts:4) 承载沟通、匹配周围代码、完整最终答复；[同文件:33](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/context/dynamic-sections.ts:33) 强调继续执行、已有决定、完成后再结束。可改写成 Pidex 中性文案；终端展示描述不适合 Desktop，且“用户不能中途回答”与 Pidex 可交互能力冲突，不能照搬。

3. **工具 schema 不重复镜像，指导按实际能力生成。** [context/builder.ts:49](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/context/builder.ts:49) 的 `setToolRegistry` 明确不再镜像 schema 到 system；[同文件:154](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/context/builder.ts:154) 传 actual guidanceToolNames；[dynamic-sections.ts:50](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/context/dynamic-sections.ts:50) 目前实际输出 Skill 指导，而 Agent/Ask 指导是注释代码。可借鉴能力条件化与去重；不能把注释块当已启用行为。

4. **真实用户身份由来源保留，非从 XML/role 推断。** [runtime/helpers/provider-request-messages.ts:50](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts:50) 维护 sourceEntries、origin、latestRealUserMessageIndex；[同文件:67](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts:67) 明确用户字面 `<system-reminder>` 不应误认 meta。这是 Pidex 当前用户重复注入问题很有价值的对照：测试应检查最终请求中真实用户出现次数及身份，而非只检查模板快照。

5. **缓存与模型分支位于能力/请求层，稳定体保持短。** [context/builder.ts:255](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/context/builder.ts:255) 分稳定和动态 system blocks；[runtime/helpers/provider-request-messages.ts:336](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts:336) 为末尾非 system 消息设置缓存标记。[runtime-provider-request-messages.ts:71](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/runtime/helpers/runtime-provider-request-messages.ts:71) 按 `supportsMidConversationSystem`/配置决定投影方式；[context/sections/env-info.ts:93](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/context/sections/env-info.ts:93) 注入实际模型身份。所读主 builder 未见按模型名维护整套工程人格，不应凭多模型产品定位推断存在多套提示词。

6. **提醒与工具发现具有来源契约及恢复语义。** [system-reminder/source.ts:114](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/system-reminder/source.ts:114) 定义 current-turn、mid-turn 等来源策略；[tool/handlers/tool-search.ts:37](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/tool/handlers/tool-search.ts:37) 从当前 allowed catalog 搜索并输出真实引用；[runtime/helpers/runtime-provider-request-messages.ts:25](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/runtime/helpers/runtime-provider-request-messages.ts:25) 同步 tools 和历史，避免保留引用却发空 tools。[runtime/helpers/compact-post-reminders.ts:9](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/runtime/helpers/compact-post-reminders.ts:9) 对最近读取文件恢复带预算的内容或引用，并去重。可借鉴类型、生命周期、去重；不必复制其复杂投影实现或默认预算。

7. **轨迹工具值得借鉴，但不是现成可用的效果评测系统。** [tools/prompt-trajectory/src/message-continuity.ts:5](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/tools/prompt-trajectory/src/message-continuity.ts:5) 比较历史 append-only，允许末尾 user block 追加；[同文件:81](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/tools/prompt-trajectory/src/message-continuity.ts:81) 只在比较时忽略 cache marker 漂移。对应 [README.md:8](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/tools/prompt-trajectory/README.md:8) 的 Current limitations 说明 `record:prompt` 执行前失败、model-io 默认日志 messages 被裁剪，[runner 尚不比较 expect 文件](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/tools/prompt-trajectory/README.md:74)，仅录制供人工检查。它提供请求连续性、角色、工具引用的回归思路，不证明成功率，也不能把 non-incremental-change 解释为缓存未命中。本次未运行工具。

## 对 Pidex 的直接启示

优先验证最终请求再扩充文本：真实用户当前输入恰好一次；权限说明与运行时事实一致；提示词预览复用实际组装结果；tool guidance 只指向实际可用工具。上述四项属于请求正确性，增加模板长度无法补救。

可改写复用的行为是：读代码后修改；复用现有实现；对依赖调用顺序执行、独立调用可并行；失败先诊断再重试；测试范围匹配改动；准确报告已验证、未验证、阻塞；压缩不终止任务；用户反馈与已决定事项要保留。每条都应有具体触发场景，避免堆砌同义的“主动、专业、完整”。

不可机械复制的是产品身份、终端专用格式、工具名、模型内部开关、服务端缓存字段、组织专用渠道、无条件子代理策略、内部思维输出格式以及参考项目对用户在场/授权的假设。提示词指导不替代宿主权限判定。

最小验证建议是检查少量实际请求轨迹：普通代码修改、工具不可用、Plan 切换、权限拒绝、MCP 晚连接、模型切换、压缩恢复。先验证来源/role/顺序/重复/引用一致性，再通过真实任务判断完成率和误调用；没有实测前不宣称任何参考文案带来效果提升。

未做：三个项目构建、运行、联网验证及全仓审计。风险：Claude 来源不完备；Codex/ZCode 为本地快照，feature/capability 与发行环境可能不同。
