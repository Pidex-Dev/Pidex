# Pidex 提示词工程差距分析

研究日期：2026-11-08。范围为用户指定的三个本地源码目录及 Pidex 当前工作区；这是研究结论和实施建议，不改变现行产品、安全或数据契约。没有修改运行时代码，没有调用模型进行效果评测。

## 结论

Pidex 已有提示词分段、来源标记、权限注入、延迟能力目录、缓存适配、turn 冻结和压缩恢复。主要差距是默认工程行为指导不足、组装链路丢失语义、预览不能完全代表实际请求，以及缺少本次范围内可见的任务行为对比证据。继续增加提示词框架收益有限，优先修复模型实际收到的内容。

“任务体验差由这些问题造成”仍需同模型对比验证；源码可以确认结构与内容缺陷，不能直接给出成功率或收益百分比。

## 三个参考项目分别学什么

| 来源 | 可借鉴的重点 | 对 Pidex 的实际用法 | 不能直接照搬的部分 |
| --- | --- | --- | --- |
| Claude Code 本地快照 | 具体任务行为、失败后的诊断、控制修改范围、按工具集生成指导、稳定前缀和动态段分离 | 改编 Doing tasks 和 Using your tools 的通用行为；保留当前 Pidex 工具名与判权链 | CLI 品牌、内部开关、私有服务、特定工具和内部用户实验规则 |
| Codex 本地源码 | 基础指令、模型指令、开发者约束与动态上下文的组合；工作区保护和任务完成标准 | 建立清楚的默认工程行为；先确认实际模型指令来源，再决定是否需要适配 | 单个旧模型模板、ASCII 默认值、CLI 输出约定、不同的工具与 OS 隔离语义 |
| ZCode 本地源码 | identity 与行为段分开；按实际工具生成指导；区分真实用户来源；请求轨迹连续性检查 | 精简身份段，把篇幅给行为规则；跟踪真实请求来源和上下文投影 | 另一套权限/记忆/多代理状态机；尚未验证可运行的轨迹工具 |

参考项目的详细调用链、文件行号与来源限制见[来源研究记录](./prompt-engineering-reference-notes.md)。

Claude 的任务指导可直接看到对“只回答不执行”“失败立即换路”“额外重构”“提前抽象”的纠偏：[prompts.ts:199](D:/GitHubProject/Agent/claude-code-master/src/constants/prompts.ts:199)。其工具指导依据当前工具集合生成，并说明独立调用与依赖调用的区别：[prompts.ts:269](D:/GitHubProject/Agent/claude-code-master/src/constants/prompts.ts:269)。稳定和动态内容的返回边界在 [prompts.ts:560](D:/GitHubProject/Agent/claude-code-master/src/constants/prompts.ts:560)。这些代码中的条件分支不能一概当成默认启用行为。

Codex 实际启动链明确按配置覆盖、历史基础指令、当前模型模板的顺序解析：[session/mod.rs:762](D:/GitHubProject/Agent/codex/codex-rs/core/src/session/mod.rs:762)。最终请求又将基础指令放入消息前缀：[client.rs:988](D:/GitHubProject/Agent/codex/codex-rs/core/src/client.rs:988)。仓库中的一个基础模板明确处理 dirty worktree、修改范围和交付表达：[gpt_5_codex_prompt.md:1](D:/GitHubProject/Agent/codex/codex-rs/core/gpt_5_codex_prompt.md:1)；它不代表当前所有模型的最终提示词。

ZCode 的身份段仅承担身份与稳定 Harness 规则：[identity.ts:21](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/context/sections/identity.ts:21)。沟通、持续执行及上下文管理放在独立行为段：[dynamic-sections.ts:4](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/packages/core/src/context/dynamic-sections.ts:4)。其轨迹工具提供请求记录与连续性检查思路，但文档明确列出录制故障，testcase runner 尚未自动比较 expect.json：[README.md:8](D:/GitHubProject/Agent/ZCode/apps/zcode-cli/tools/prompt-trajectory/README.md:8)。

## Pidex 实际输入链路

```text
ThreadService / SubagentService
  → createPromptSections
  → AgentRuntimeService：重写权限段、加入能力目录
  → PromptComposer：instructions + contextual-user items
  → 冻结 turn composition（恢复时复用冻结快照）
  → ExecuteHarnessRun：instructions 作为 systemPrompt
                        contextItems + 附件 + request.content 作为用户输入
  → AgentHarness / pi-ai → provider
```

关键实现：[ThreadService.ts:1642](../../apps/agent/src/session/ThreadService.ts:1642)、[AgentRuntimeService.ts:1475](../../apps/agent/src/orchestration/AgentRuntimeService.ts:1475)、[PromptComposer.ts:123](../../apps/agent/src/prompt/PromptComposer.ts:123)、[ExecuteHarnessRun.ts:38](../../apps/agent/src/orchestration/pi/ExecuteHarnessRun.ts:38)。

## 已确认的问题与影响

### 1. 权限行为说明在最终组装前被覆盖

ThreadService 生成了面向模型的权限说明，包括文件访问、Shell 环境、审批策略，以及普通调用应直接交给宿主判权等行为：[ThreadService.ts:1627](../../apps/agent/src/session/ThreadService.ts:1627)。

AgentRuntimeService 随后对所有 `permission.resolved` 段重新赋值为 `Resolved permission config: <JSON>.`：[AgentRuntimeService.ts:1475](../../apps/agent/src/orchestration/AgentRuntimeService.ts:1475)。子代理同名段中的 ceiling 提醒也会经过这个替换。这不会取消宿主实际判权，但会使模型失去已写好的操作指导。

建议：由最终 resolved policy 生成一份共享的人类可读说明，主 Agent、子 Agent 和预览都使用它；不能只删除替换而放弃使用最终权限事实。

### 2. 当前用户请求在同一次输入中出现两次

`createPromptSections` 已把 `userMessage` 放入 `turn.user-message`：[Sections.ts:329](../../apps/agent/src/prompt/Sections.ts:329)。Composer 将其转成带 `context_data` 包装的 user item。`promptContext` 拼接所有 items 后，又追加 `request.content`：[ExecuteHarnessRun.ts:38](../../apps/agent/src/orchestration/pi/ExecuteHarnessRun.ts:38)。ThreadService 传给两处的是同一个 `content`。

可确认的结果是输入重复；附件标签、长请求、内嵌规则也会随请求一起重复。其对模型注意力的影响尚未量化，不应说成已证明的准确率下降。

建议：当前用户请求只保留一个权威入口，放在上下文和附件之后；保持诊断、预算、冻结和恢复对同一份输入的引用，不只在预览里去重。

### 3. 默认工程行为偏薄，细节纠错占据主要篇幅

默认 `builtin.execution` 只有 444 个 JavaScript 字符（本地调用 `createPromptSections` 实测；不含工具 schema、其他段和用户设置），6 条规则中有多条用于路径、Read/Edit 和补丁格式：[Sections.ts:53](../../apps/agent/src/prompt/Sections.ts:53)。

其中虽有“完成必要修改并验证”，但对下列高频行为缺少明确默认指导：行动请求的完成标准；仅分析请求的停止边界；沿调用方定位根因；保护已有改动；失败后依据证据调整；避免额外抽象和无关清理；仅对实质未知提问；准确报告已做和未做的验证。

建议：直接改编成熟来源中的这些通用规则，放进现有 execution 段；不要另建提示词引擎。规则数量按覆盖行为决定，不设任意字数或 token 配额。

### 4. 预览与真实运行并非同一个结果

预览自行发现指令、回忆记忆、生成 sections 并 compose：[ThreadService.ts:565](../../apps/agent/src/session/ThreadService.ts:565)。真实运行还处理显式 Skill、插件引用、Goal、计划反馈、Hook、恢复证据、当前时间、最终权限和冻结快照。预览也未经过 `promptContext` 的最终用户输入拼接。

因此预览可解释部分来源，却不能证明“模型实际收到的就是这个”。

建议：优先让已运行 turn 的诊断读取其冻结 composition；对尚未运行的预览明确标注为预计内容，并复用可复用的组装入口。最终 provider 请求检查只用于受控 fixture，不能默认记录用户正文和凭据。

### 5. role 和 authority 元数据不等于实际 provider 消息层级

Composer 把所有非 `contextual-user` 段拼成一个 instructions 字符串：[PromptComposer.ts:123](../../apps/agent/src/prompt/PromptComposer.ts:123)。运行时把它作为单个 `systemPrompt` 使用：[ExecuteHarnessRun.ts:163](../../apps/agent/src/orchestration/pi/ExecuteHarnessRun.ts:163)。因此 `system`、`developer` 及用户设置的 authority 区分主要用于本地组织和诊断，没有按原角色逐段传递。

这与 pi-ai 接口的表达方式有关，不能仅凭扁平化认定存在越权漏洞；宿主判权仍独立有效。可以先在字符串里明确内建规则、用户偏好和权限事实边界。若要改变 provider 消息角色，需要跨 provider 验证，不能顺手提升仓库或 MCP 内容的权限层级。

### 6. 工具说明偏实现术语，工具指导扩展口尚未接入生产调用

Bash/PowerShell 描述包含 Pi tool_call、Hook、hard-deny、幂等门禁等宿主实现术语，却较少帮助模型判断典型用法：[ToolRegistry.ts:997](../../apps/agent/src/tool/ToolRegistry.ts:997)。Read/Write 的参数描述仍偏向“工作区文件”，主描述又说明可按绝对路径请求工作区外操作：[ToolRegistry.ts:574](../../apps/agent/src/tool/ToolRegistry.ts:574)。

`toolGuidance` 和 `requiredTools` 已有接口与过滤，但本次搜索 `apps/agent/src` 未见生产调用方提供 `toolGuidance`：[Sections.ts:202](../../apps/agent/src/prompt/Sections.ts:202)。

建议：工具说明采用“何时用、何时不用、输入、关键失败恢复”的顺序；保留必要的权限事实，减少内部名词。优先修改现有 definition；仅把跨工具选择策略放入现有 guidance，不把完整 schema 再复制到 system。

### 7. 项目指令发现依赖启动 cwd，缺少自动覆盖目标子目录的证据

InstructionDiscoveryService 只遍历 workspace root 到传入 cwd 的祖先链：[InstructionDiscoveryService.ts:85](../../apps/agent/src/prompt/InstructionDiscoveryService.ts:85)。主任务传入会话 cwd，子代理也在创建时发现指令。ToolExecutor 对 Read 有 Skill 读取跟踪，本次相关路径未见按目标业务文件自动注入子目录 AGENTS 的对应机制。

这不代表模型一定漏读：根 AGENTS 可以要求它自行读取。但在根目录会话修改深层文件时，子目录规则并不会仅因文件被访问就自动进入这条发现链。

建议：第一轮先增加“触及目录前读取适用子目录 AGENTS”的行为指导。只有真实轨迹证明仍频繁遗漏，才设计按访问路径发现的机制，避免现在引入状态和失效逻辑。

### 8. 现有提示词测试主要证明组装契约，不能证明任务表现

[Prompt.test.ts](../../apps/agent/test/Prompt.test.ts) 已覆盖指令发现、UTF-8、预算、来源、能力分页、缓存策略、模式和固定规则。这些值得保留。字符串包含断言仍无法回答模型是否少询问、能否完成任务、是否减少无关修改。

本次未发现足以给出 Pidex 相对三个参考项目表现排名的同模型行为数据。因此不建议通过提示词长度、文件数量或单个演示宣布效果更好。

## 推荐实施顺序与影响面

第一批只修组装与可观测性：权限说明单点生成；用户请求唯一入口；已有 turn 的预览对齐冻结结果。影响 `ThreadService`、`SubagentService`、`AgentRuntimeService`、`PromptComposer`/Types（按实际必要性）、`ExecuteHarnessRun`、相关 prompt/runtime 测试及 promptPreview 消费方。必须保留暂停、恢复、工具暴露和幂等语义；现有冻结 turn 不应被静默重写。

第二批补默认行为并整理常用工具说明：复用 `Sections.ts`、`ToolRegistry.ts` 与现有垂直工具定义；覆盖主 Agent 和各 profile。Plan/Grill 已按模式注入，不应把所有模式说明混进 Chat；现有模式状态机和统一判权不变。模型特化只有在对比显示稳定问题后再加，不建立每个模型一份大模板。

第三批用小规模固定任务比较旧版和候选版：固定模型、推理参数、工具集、仓库 fixture 和用户输入；观察最终行为和真实请求结构。开始不需要新平台、新 UI 或自动裁判。UI 如受预览调整影响，仅列影响面并由用户自行验收。

| 固定任务 | 观察结果 |
| --- | --- |
| 明确要求修复已定位 bug | 完成必要实现和验证，不停在提案 |
| 仅要求分析原因 | 提供证据，不擅自修改业务代码 |
| 仓库已有无关 dirty 改动 | 保留用户改动，不顺手整理 |
| 命令或 Edit 首次失败 | 读取错误并修正，不原样重复 |
| 能从仓库确认的问题 | 先调查，不把事实查询交给用户 |
| 使用延迟工具和显式 Skill | 正确发现、激活、读取并遵循依赖顺序 |
| 根会话修改带局部 AGENTS 的目录 | 实施前读取并遵循适用指令 |
| 长对话压缩或审批后恢复 | 保留目标、未完成工作和已完成副作用，不重复执行 |

记录任务完成情况、必要验证真实性、无关修改、无效工具重试、不必要提问、输入 token 和请求连续性；结构性回归用本地 fixture，行为收益用同模型多次运行复核。权限与恢复不变量必须继续通过现有宿主测试，不能交给提示词承担。

## 明确不做

不重建 Harness、权限引擎或 workspace；不复制参考仓库的整套记忆/插件/多代理实现；不把全部 Skills 正文和工具说明常驻注入；不机械替换成某份 Codex 或 Claude 完整提示词；不因本轮研究添加依赖、模型 API 调用、UI 或数据库变更。

## 验证边界

本轮做了源码追踪和一次无模型调用的默认 section 长度检查；未运行三个参考项目、未启动浏览器、未运行行为评测。Claude 快照缺少完整工程与许可证文件，存在 feature gate；ZCode 轨迹工具有已记录限制。参考项目之间的效果优劣、候选提示词收益和缓存命中改善均未实测。
