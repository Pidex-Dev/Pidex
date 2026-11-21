import type { DecisionPointManifest } from '@pidex/shared/decision'
import { toolRiskSpec } from './ToolRisk'
import { toolApprovalSpec } from './ToolApproval'
import { toolConstraintSpec } from './ToolConstraint'
import { toolInjectionSpec } from './ToolInjection'
import { toolDescriptionSpec } from './ToolDescription'
import { toolAdmissionSpec } from './ToolAdmission'
import { toolAdmissionTestLogSpec } from './ToolAdmissionTestLog'
import { browserActionRiskSpec } from './BrowserActionRisk'
import { instructionScreenSpec } from './InstructionScreen'

export * from './ToolRisk'
export * from './ToolApproval'
export * from './ToolConstraint'
export * from './ToolInjection'
export * from './ToolDescription'
export * from './ToolAdmission'
export * from './ToolAdmissionTestLog'
export * from './BrowserActionRisk'
export * from './InstructionScreen'

/** Registration list for the safety plane: pass to DecisionService.registerManifest once at assembly. */
export const SAFETY_MANIFEST: readonly DecisionPointManifest[] = [
  {
    id: 'tool.risk',
    group: 'safety',
    title: 'Risk command pre-check',
    titleZh: '风险命令快速前置判别',
    summary:
      'For rule-flagged commands on the auto-review path, checks whether the user explicitly requested the action. Only adds confirmations; never lowers the static risk floor.',
    summaryZh:
      '自动审查路径下，对规则命中的风险命令判断是否由用户明确请求；只增加确认，绝不降低静态风险下限。',
    defaultMode: 'shadow',
    feature: 'decision.safety',
  },
  {
    id: 'tool.approval',
    group: 'safety',
    title: 'Approval assistance',
    titleZh: '审批辅助判别',
    summary:
      'Judges whether a call routed to auto-review is a step the task needs. Only a high-confidence "needed" bound to the action hash and authorization version may allow; otherwise the existing review applies.',
    summaryZh:
      '判断进入自动审查的调用是否为任务所需步骤；仅高置信 needed 且绑定动作指纹与授权版本时可放行，否则回退既有审查。',
    defaultMode: 'shadow',
    feature: 'decision.safety',
  },
  {
    id: 'tool.constraint',
    group: 'safety',
    title: 'User constraint check',
    titleZh: '用户硬约束核对',
    summary:
      'Checks side-effecting calls against the hard constraints the user confirmed in this conversation. Only narrows what the permission chain allows.',
    summaryZh: '核对有副作用的工具调用是否违反本会话中用户确认的硬限制；只收窄允许范围。',
    defaultMode: 'shadow',
    feature: 'decision.safety',
  },
  {
    id: 'tool.injection',
    group: 'safety',
    title: 'Prompt injection screening',
    titleZh: '提示词注入筛查',
    summary:
      'Screens external content (web results, browser pages, MCP output, fetched shell output) before the model reads it. Flagged passages are replaced by a single-line placeholder with a notice.',
    summaryZh:
      '在模型读取外部内容（网页、浏览器页面、MCP 输出、抓取型命令输出）前筛查面向 AI 的注入指令；命中段落替换为单行安全占位并提示。',
    defaultMode: 'active',
    feature: 'decision.safety',
  },
  {
    id: 'tool.description',
    group: 'safety',
    title: 'Tool description screening',
    titleZh: '工具描述投毒筛查',
    summary:
      'Screens MCP tool descriptions for orders beyond calling the tool. Poisoned tools are removed from exposure and their calls refused; verdicts are cached by name and description hash.',
    summaryZh:
      '筛查 MCP 工具描述中夹带的越权指令；命中工具从暴露集剔除并拒绝调用，按名称与描述哈希缓存结论。',
    defaultMode: 'active',
    feature: 'decision.safety',
  },
  {
    id: 'tool.admission',
    group: 'safety',
    title: 'Long output admission',
    titleZh: '超长输出准入',
    summary:
      'Classifies chunks of overlong tool output; only confident noise is folded out. The full text is archived with a read pointer so a wrong verdict stays recoverable.',
    summaryZh:
      '对超长工具输出按块分类，仅折叠高置信噪声段落；全文归档并附读取指针，误判可恢复。',
    defaultMode: 'shadow',
    feature: 'decision.safety',
  },
  {
    id: 'tool.admission.test-log',
    group: 'safety',
    title: 'Test log selection',
    titleZh: '测试日志筛选',
    summary:
      'Folds exact duplicate test-log passages, then asks per remaining candidate whether the goal needs it on top of the summary and failures, which always stay.',
    summaryZh:
      '先折叠完全重复的测试日志段落，再按候选段判断目标是否需要摘要与失败信息之外的内容；摘要与失败始终保留。',
    defaultMode: 'shadow',
    feature: 'decision.safety',
  },
  {
    id: 'browser.action.risk',
    group: 'safety',
    title: 'Browser action risk',
    titleZh: '浏览器高危动作风控',
    summary:
      'On auto-review, checks state-changing browser actions for irreversible external side effects (payments, deletions, sending, OAuth) not explicitly requested by the user.',
    summaryZh:
      '自动审查模式下，检查有副作用的浏览器操作是否触发非用户明确请求的不可逆外部提交（支付、删除、发送、OAuth 授权等），命中则升级人工确认。',
    defaultMode: 'shadow',
    feature: 'decision.safety',
  },
  {
    id: 'instruction.screen',
    group: 'safety',
    title: 'Untrusted instruction & skill screen',
    titleZh: '外部指令与 Skill 投毒筛查',
    summary:
      'Screens untrusted repository instructions (AGENTS.md/CLAUDE.md) and workspace or plugin Skills for prompt injection and exfiltration orders, skipping builtin and user-global sources.',
    summaryZh:
      '筛查不可信仓库指令（AGENTS.md/CLAUDE.md）与仓库/插件 Skill 中的越权或注入段落（跳过内置与用户全局目录），按内容哈希缓存。',
    defaultMode: 'active',
    feature: 'decision.safety',
  },
]

/** The safety-plane specs, keyed by spec id. */
export const SAFETY_SPECS = {
  'tool.risk': toolRiskSpec,
  'tool.approval': toolApprovalSpec,
  'tool.constraint': toolConstraintSpec,
  'tool.injection': toolInjectionSpec,
  'tool.description': toolDescriptionSpec,
  'tool.admission': toolAdmissionSpec,
  'tool.admission.test-log': toolAdmissionTestLogSpec,
  'browser.action.risk': browserActionRiskSpec,
  'instruction.screen': instructionScreenSpec,
} as const