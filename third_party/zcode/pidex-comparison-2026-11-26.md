# Pidex 与 ZCode 修复项对照

2026-11-26 核查。ZCode 使用本地 v4.0.0（a4b44451），Pidex 使用 0a9e65c08 上的实际工作区，含未提交改动。核对了中文官网 17 个版本的发布说明，并对下列能对应到 Pidex 的行为做了源码追踪、临时数据验证或已有测试。源码位置以下均相对各自仓库。[官方发布记录](https://zcode.z.ai/cn/changelog?page=3)

## 已确认的行为

| ZCode 版本与问题 | Pidex 验证结果 | 代码依据 |
| --- | --- | --- |
| 4.0.0，归档永久删除 | 设置页在确认框打开时保存目标。随后从另一处恢复一个空闲会话，再确认删除，服务端仍会永久删除它。临时 SQLite 检查得到「已恢复、报告删除成功、会话不存在」。ZCode 在事务中复核归档状态，已恢复的目标会跳过。 | Pidex [确认框目标](../../apps/desktop/renderer/src/features/settings/ArchivedConversationsSettings.tsx)、[删除事务](../../apps/agent/src/session/ThreadHistoryService.ts)；ZCode `packages/services/src/session/taskIndexRepo.ts` 第 1086 行。 |
| 4.0.0，服务商错误误归类 | 向 Pidex 的服务商错误转换函数传入没有 HTTP 状态字段、仅在说明中提到 HTTP 429 的异常，返回 RATE_LIMITED。可影响模型目录等调用该转换器的功能。此验证限于错误分类层。 | [错误分类](../../apps/agent/src/provider/ProviderError.ts)、[模型目录调用方](../../apps/agent/src/provider/runtime/ModelListing.ts)。 |
| 3.19.1，输入框误触发语音 | 设置页可以录入 Shift+D。语音功能可用时，在编辑器输入大写 D 会命中该绑定，编辑器阻止默认输入并切换听写。已用实际录制格式化与匹配函数验证。ZCode 对编辑区内仅以 Shift 修饰的可打印字符有专门豁免。 | Pidex [快捷键](../../apps/desktop/renderer/src/features/speech/VoiceRecordingCache.ts)、[输入框](../../apps/desktop/renderer/src/features/session/composer/ComposerCard.tsx)；ZCode `packages/ui/src/voice-input/ui/useVoiceInputShortcut.ts` 第 53 行。 |
| 3.19.1，Windows 找不到 Git Bash | 在模拟的按用户安装布局中，Git 的 cmd 目录已加入 PATH，bash.exe 位于同一安装的 bin 目录。桌面终端将 Git Bash 标为不可用。Agent 命令执行器另有查找逻辑，会从 git.exe 的位置推导，并探测用户安装目录。 | [桌面终端](../../apps/desktop/electron/src/terminal/ShellProfileService.ts)、[Agent 执行器](../../apps/agent/src/tool/Shell/UnifiedExecManager.ts)。 |
| 3.18.2，日期格式不跟随界面语言 | Pidex 可选择 English (US)，自动化运行时间和日历仍显式使用 zh-CN。同一时间在本机调用运行记录格式化函数得到「11/26 17:30」，en-US 得到「11/26, 05:30 PM」。 | [自动化时间](../../apps/desktop/renderer/src/features/automation/AutomationModel.ts)、[日历](../../apps/desktop/renderer/src/features/automation/AutomationCalendar.tsx)、[界面语言](../../apps/desktop/renderer/src/features/i18n/LocaleProvider.tsx)。 |
| 3.17.2，损坏配置被覆盖 | 桌面外观配置出现 JSON 语法错误后会删除源文件并写入默认设置，现有测试明确断言这一行为。Agent 主配置的局部写入会在已有语法错误时拒绝保存。影响限于对应配置路径。 | [外观存储](../../apps/desktop/electron/src/settings/AppearanceSettingsStore.ts)、[测试](../../apps/desktop/electron/test/AppearanceSettingsStore.test.ts)、[Agent 主配置](../../apps/agent/src/config/ConfigService.ts)。 |

## 已有保护及其验证范围

| ZCode 记录 | Pidex 证据及结论 |
| --- | --- |
| 4.0.0、3.12.3、3.11.2，切换模型或服务商后丢上下文 | 当前分支分别重建消息和模型元数据。以一条用户消息和一个切换服务商的记录调用真实重建函数，新模型与旧消息同时返回。SQLite 测试也覆盖消息持久化。跨真实服务商、切换与流式请求重叠、含工具和多模态历史的组合仍待验证。[历史重建](../../apps/agent/src/storage/session/Session.ts)、[SQLite 测试](../../apps/agent/test/SqliteSession.test.ts)。 |
| 3.19.1、3.12.3、3.10.1/2，限流、流中断与重试 | 读取 Retry-After 秒数、日期和毫秒头；限额耗尽及部分永久错误停止重试。有用例验证工具结果已提交后重试不会重复该工具。[实现](../../apps/agent/src/orchestration/harness/ModelAttempt.ts)、[已通过用例](../../apps/agent/test/harness/ModelRetry.test.ts)。 |
| 3.19.1、3.12.3，停止后误恢复或重启后丢子任务 | 现有测试验证已停止轮次不会被旧执行凭据复活，持久化子任务队列与结果可跨重启保留。这些测试覆盖运行状态，未检查每个界面上的活动记录。[恢复](../../apps/agent/test/ExecutionRecoveryInvariants.test.ts)、[子任务](../../apps/agent/test/SubagentCollaboration.test.ts)。 |
| 3.17.2，子代理权限超过父任务 | 测试覆盖三层只读权限继承与父代理显式工具白名单约束后代。[协作用例](../../apps/agent/test/SubagentCollaboration.test.ts)。 |
| 3.16.3，关闭终端标签后进程残留 | 关闭入口按终端实例调用宿主关闭操作，终端管理器测试覆盖停止 PTY、并发关闭及晚到的启动结果。未使用真实 Windows 子进程树做系统级验证。[关闭入口](../../apps/desktop/renderer/src/features/terminal/TerminalPanel.tsx)、[终端管理器测试](../../apps/desktop/electron/test/TerminalManager.test.ts)。 |
| 3.16.2，上下文溢出后无响应 | 已有用例验证第一次服务商溢出触发压缩并继续，连续第二次溢出返回明确错误，还验证失败候选保留历史。[上下文压缩测试](../../apps/agent/test/RuntimeCompaction.test.ts)。 |
| 3.18.2、3.15.1，更新安装或下载重试 | 打包版显式关闭退出时自动安装，已下载状态才允许启动安装；出错后界面提供重新检查入口。安装前后台未确认停止时会阻止安装。下载中关闭最后窗口的情况另列下节。[更新器](../../apps/desktop/electron/src/update/DesktopAutoUpdater.ts)、[更新菜单](../../apps/desktop/renderer/src/features/layout/sidebar/DesktopUpdateMenu.ts)。 |
| 3.15.1，内置浏览器默认允许网站权限 | 浏览器访客会话设置的权限检查及请求处理器均默认拒绝。该结论针对访客网页，不涵盖主窗口主动请求麦克风等其他入口。[访客权限](../../apps/desktop/electron/src/browser/BrowserGuestManager.ts)。 |
| 3.14.1、3.16.2，输入草稿被清空或串会话 | 现有测试验证复位目标草稿的模式时保留文本、附件与技能，其他草稿键不变。尚未验证模型切换和输入法未提交文本的所有交互。[草稿测试](../../apps/desktop/renderer/test/ComposerDraftStore.test.ts)。 |

## 仍需区分的场景

- **批量归档删除的耗时。** Pidex 确认后为每个 ID 各发一个请求，通过 Promise.allSettled 同时启动；ZCode 按工作区批量提交。请求数差异可以确认，未测量会话数达到多少时用户会感到卡顿。[Pidex 批量入口](../../apps/desktop/renderer/src/features/settings/ArchivedConversationsModel.ts)。
- **退出与安装。** Pidex 的普通退出流程会停止集成终端，没有按活动终端数量提示。后台 Agent 可以独立于桌面进程存活，终端被关闭不能推导为所有 Agent 任务都会停止。更新下载在 Electron 主进程内；关闭最后一个窗口会触发退出，下载能否在下次启动续传需要安装包验证。[退出流程](../../apps/desktop/electron/src/main.ts)、[后台生命周期测试](../../apps/desktop/electron/test/BackgroundRuntime.test.ts)。
- **会话启动卡住。** Pidex 的 sidecar 健康检查有截止时间，连接重试有上限。打开某条会话还涉及 RPC、历史和项目数据，因此仅凭健康检查无法排除首次发送或恢复时卡住。[就绪检查](../../apps/desktop/electron/src/sidecar/Readiness.ts)、[连接管理](../../apps/desktop/electron/src/sidecar/Supervisor.ts)。
- **自动化“立即运行”。** 前端展示调用失败的错误消息；已受理的执行若随后抛出未知异常，运行记录可退化为 INTERNAL_ERROR。不同失败阶段的界面提示仍需分别验证。[前端控制器](../../apps/desktop/renderer/src/features/automation/UseAutomationController.ts)、[后台执行](../../apps/agent/src/automation/AutomationRunCoordinator.ts)。
- **相近名称、不同功能。** ZCode 的动态脚本工作流与 Pidex 的工作流分组、上下文和步骤接口实现不同。3.14.3 的脚本并发与侧栏问题不能套用到 Pidex。3.14.4 与 3.14.5 分别涉及 ZCode 免费套餐验证码和额度重置次数；同样缺少可直接对应的 Pidex 产品入口。[Pidex 工作流接口](../../apps/agent/src/transport/rpc/handlers/Workflow.ts)。
- **仍无结论的发布项。** 包括真实 SSH／WSL 断线重连、登录时钟偏差和密钥环、IME 未上屏候选、流式批注偏移、窄窗口布局、安装升级及多平台显示、3.15.3 的并发服务商请求等。两个项目都有相似功能或一方有测试，都不足以断定线上表现相同。
- **代码来源。** Pidex 记录了模型选项取自 ZCode 3.16.2，另有浏览器和权限设计来源。比对该版本与 v4.0.0 时，ZCode 的 packages/model-option-map/src 没有源码差异。此结果仅适用于该子目录，未验证模型目录数据是否一致。[来源记录](UPSTREAM.md)。

本次运行 Pidex 已有测试共 11 个文件、117 个用例，全部通过。另用临时 SQLite 和内存输入验证了归档误删、服务商错误分类、语音快捷键、日期格式、Git Bash 检测和模型历史重建。未启动自动化浏览器或安装真实更新。
