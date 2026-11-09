# Prompt engine source provenance

Pidex 的 prompt engine v2 参考了以下本地源码快照。实现以 Pidex 的 TypeScript 架构、安全不变量和产品决策重新组织；没有引入参考仓库的 TUI、私有服务协议或品牌专属逻辑。

## OpenAI Codex

- 来源：`D:/GitHubProject/Agent/codex-main`
- 许可：Apache License 2.0（见来源根目录 `LICENSE`）
- `codex-rs/core/src/config/resolved_permission_profile.rs` — SHA-256 `94234BA35D5EC3958EF6EEF44ECF259FD610459AB47DF62E1DE17BBE136886B4`
- `codex-rs/core/src/guardian/review_session.rs` — SHA-256 `2B92E6E89B633B5A39A84E09A9C0A03CB710DD2D1BFDF0CF83BC4D0C31476221`
- `codex-rs/core/gpt_5_codex_prompt.md` — SHA-256 `42842BE69650AE563D212695E8D3F3591534908FD8CA33B63F742DAF41F88B65`

借鉴范围：permission profile、approval policy、Guardian 增量会话、工具注册、Plan/协作模式和执行/验证提示词骨架。

## Claude Code reference snapshot

- 来源：`D:/GitHubProject/Agent/claude-code-master`
- 授权依据：本次实施由用户明确确认可复制/改编该本地快照；该记录不改变上游文件自身的权利归属。
- `src/constants/prompts.ts` — SHA-256 `7DAC778E089A7F002403DF2A2EFB6F0B9E4A450AF21766680AB8948596C10F25`
- `src/utils/hooks.ts` — SHA-256 `D95C84279ED5E57DBCDE85F116E6E590A1A06355F786E50A8FE2DDE1E555CD26`
- `src/services/SessionMemory/prompts.ts` — SHA-256 `37C52FA005CFDA8EBE3978D7E93A6101C1D956010F2A4733B9A38481D0B85975`

借鉴范围：动态 prompt sections、项目指令、Skills catalog/按需读取、Hooks 生命周期、记忆与压缩恢复。

这些 SHA-256 标识本次设计时使用的具体文件快照；来源目录不是 Git worktree，因此没有可记录的 commit SHA。


## English engineering guidance and prompt assembly (2026-11-08)

以下为本次使用的实际本地来源，不替换上文的历史快照记录。

| 来源 | 本次定位 | 采用范围 |
| --- | --- | --- |
| Claude Code reference snapshot | `D:/GitHubProject/Agent/claude-code-master/src/constants/prompts.ts`；SHA-256 `7DAC778E089A7F002403DF2A2EFB6F0B9E4A450AF21766680AB8948596C10F25` | Doing tasks 与 Using your tools：先读后改、范围控制、避免提前抽象、失败后诊断、独立调用并行 |
| OpenAI Codex | `D:/GitHubProject/Agent/codex`；revision `780d7ab09741241380586b07882c635037a6ba21`；`codex-rs/core/gpt_5_codex_prompt.md` SHA-256 `E592B97EBA9075901B71EE3CE8FEC25957E556B4B190CC6774B90B4AB5D71370` | dirty worktree 保护、提交边界、相称验证和准确交付；未采用 ASCII 默认值或发现其他修改就停止的规则 |
| ZCode | `D:/GitHubProject/Agent/ZCode`；revision `3c5b227649371507ddc4eb46ac5133afe6db1cab`；`apps/zcode-cli/packages/core/src/context/dynamic-sections.ts` SHA-256 `09E3B89DBCA1C211C0875971BF261BEA597F009E197C19E1C6782567D0D3E161` | 沟通、完整最终答复、上下文压缩后的持续执行，以及仅分析请求的停止边界 |

文案在现有 `Sections.ts` 和工具定义中改编，适配 Pidex Desktop、实际工具名称与宿主判权。未引入参考项目的框架、Provider、状态机、品牌、内部实验分支或终端专用约定。Claude 目录是不完整源码快照，不能据此证明官方发布版本或特性启用情况；其本地复制/改编由用户明确要求，未改变来源文件的权利归属。

内建模型指令与第一方工具说明使用英文；用户输入、设置、项目指令、第三方 Skill/MCP 原文及证据保留原语言。界面文案与模型输出语言要求独立于内建指令语言。

### 组装与预览语义

- 新组成的 contextual item 带可选 `sectionID`；`turn.user-message` 直接保留用户原文，最终位于其他上下文和文本附件之后，仅发送一次。旧冻结 item 缺少该字段时沿用原组装布局，不改写存储快照。
- 权限说明由 `formatPermissionInstructions` 从现有 resolved policy 生成，主 Agent、子 Agent、预计预览和实际运行共用；提示词不代替宿主判权。
- `prompt/preview.previewKind` 为 `frozen` 或 `estimated`。有活动主 turn 时优先读取该 turn 的快照；没有活动 turn 时读取最近主 execution 的快照；当前 turn 尚未冻结或没有历史快照时返回预计内容。损坏快照返回安全错误，不伪装为预计内容。
- 冻结预览提供 `turnId`、`compositionId`，正文与 hash 来自原快照，`sections` 为空，来源信息通过 diagnostics 保留。该路径不重新扫描能力或读取记忆。
- 预计预览复用 section、权限、工具指导与能力目录生成；MCP 仅查看已有运行时目录，不连接服务器。未建立连接的 MCP 能力可能尚未出现在预计结果中。预览不执行 Hook、激活能力或写入引用证据。
- `prompt/refresh` 只影响后续新 turn。诊断接口输出脱敏；手动压缩使用内部 prompt，避免将脱敏预览字符串反送模型。运行时原有凭据保护仍生效。

针对性验证涵盖用户来源元数据、英文第一方 fixture、冻结预览、快照损坏、既有恢复及三种 Provider 请求序列化。测试使用 faux provider 或关闭于 finally 的本地服务，不调用付费模型，不据此宣称任务成功率或缓存命中提升。
