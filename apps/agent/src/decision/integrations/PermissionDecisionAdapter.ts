import { isFullAccessPermissionConfig, isReadOnlyTaskMode } from '@pidex/shared/thread'
import type { ToolInvocation } from '../../Domain'
import type { AgentDatabase } from '../../storage/database/AgentDatabase'
import { secretScrubber } from '../../security/SecretScrubber'
import {
  guardianActionHash,
  guardianAuthorizationVersion,
  guardianReview,
  guardianRootThreadID,
} from '../../permission/Guardian'
import { hasRequestedPermissions } from '../../permission/PermissionDecisionEngine'
import type { DecisionService } from '../DecisionService'
import type { Decision } from '../DecisionEngine'
import { toolApprovalSpec, type ToolApprovalOutcome } from '../specs/ToolApproval'
import { toolConstraintSpec } from '../specs/ToolConstraint'
import { toolRiskSpec } from '../specs/ToolRisk'
import {
  browserActionRiskSpec,
  isBrowserRiskAction,
  redactBrowserInputPreview,
  type BrowserActionRiskOutcome,
} from '../specs/BrowserActionRisk'
import { taskFrameOf } from '../specs/InputSpecs'


const USER_MESSAGE_LIMIT = 8
const USER_MESSAGE_CHARS = 2_000

export function realUserMessages(
  db: Pick<AgentDatabase, 'sqlite'>,
  threadID: string,
): string {
  if (!db.sqlite) return ''
  const collect = (id: string): string[] =>
    (
      db.sqlite!
        .query(
          `SELECT content FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY created_at DESC, id DESC LIMIT ${USER_MESSAGE_LIMIT}`,
        )
        .all(id) as Array<{ content: string }>
    )
      .reverse()
      .map((row) =>
        secretScrubber.scrubText(String(row.content ?? '').slice(0, USER_MESSAGE_CHARS)),
      )
  try {
    const local = collect(threadID)
    const rootThreadID = guardianRootThreadID(db, threadID)
    const root = rootThreadID === threadID ? [] : collect(rootThreadID)
    return [...root, ...local].filter(Boolean).join('\n')
  } catch {
    return ''
  }
}

export function autoReviewAssistEligible(invocation: ToolInvocation): boolean {
  if (isReadOnlyTaskMode(invocation.taskMode)) return false
  if (isFullAccessPermissionConfig(invocation.permissionConfig)) return false
  if (invocation.permissionConfig.approvalsReviewer !== 'auto_review') return false
  if (invocation.permissionConfig.approvalPolicy !== 'auto_review') return false
  const facts = invocation.permissionFacts
  if (facts?.denyReason || facts?.hookRequiresApproval) return false
  if (facts?.forcedApproval || facts?.ruleIDs?.length) return false
  if (facts?.ruleEffect === 'ask' || facts?.ruleEffect === 'deny') return false
  if (facts?.ruleRequiresApproval) return false
  if (invocation.authorizationScope?.ruleRequiresApproval) return false
  if (invocation.authorizationScope?.computerApp) return false
  if (invocation.grantsForbidden) return false
  if (hasRequestedPermissions(invocation.input)) return false
  if (invocation.toolPolicy?.approvalStrategy === 'always-review') return false
  return true
}

export async function precheckShellRisk(
  decisions: DecisionService | null | undefined,
  db: Pick<AgentDatabase, 'sqlite'>,
  input: { threadID: string; turnID?: string | undefined; command: string; flag: string },
  options: { signal?: AbortSignal | undefined; cwd?: string | undefined } = {},
): Promise<Decision<'allow' | 'confirm'> | null> {
  const engine = await decisions?.ensureEngine(options.cwd).catch(() => null)
  if (!engine) return null
  if (engine.getMode(toolRiskSpec.id) === 'off') return null
  return engine.decide(
    toolRiskSpec,
    {
      command: input.command,
      flag: input.flag,
      userMessage: realUserMessages(db, input.threadID),
    },
    {
      signal: options.signal,
      origin: {
        threadId: input.threadID,
        ...(input.turnID ? { turnId: input.turnID } : {}),
      },
    },
  )
}

const CHECK_COMMAND =
  /^\s*(?:(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?(?:test|tests|check|typecheck|lint|build)(?:\s|$)|(?:cargo|go)\s+(?:test|build|vet|check)(?:\s|$)|pytest\b|(?:tsc|vitest|jest|oxlint|eslint|ruff|mypy)\b|[\w./\\-]*test\.(?:sh|ps1)\b|python\s+-m\s+(?:pytest|unittest)\b)/i

// INVARIANT: Whether a shell command only runs a project check (test/build/typecheck/lint) and nothing else.
export const isCheckCommand = (command: string): boolean => {
  const segments = command.split(/&&|\|\||;|\|/)
  return segments.length > 0 && segments.every((segment) => CHECK_COMMAND.test(segment))
}

const approvalCallText = (invocation: ToolInvocation): string => {
  const command = invocation.input.command
  if (typeof command === 'string') return `${invocation.name}: ${command}`
  const scope = invocation.authorizationScope
  if (scope && scope.affectedPaths.length > 0) {
    return `${invocation.name}: ${JSON.stringify({
      patchHash: scope.fingerprint,
      affectedPaths: scope.affectedPaths,
    })}`
  }
  return `${invocation.name}: ${JSON.stringify(invocation.input).slice(0, 4_000)}`
}

const approvalWhere = (invocation: ToolInvocation): string => {
  const facts = invocation.permissionFacts
  const targets = facts?.ruleTargets
  const external: string[] = [
    ...(targets?.writePaths ?? []),
    ...(targets?.readPaths ?? []),
    ...(targets?.networkDomains ?? []),
  ]
  if (facts?.externalCommand || facts?.externalWrite) {
    return external.length > 0
      ? `outside the workspace: ${external.join(', ')}`
      : 'outside the workspace'
  }
  const root = facts?.workspaceRoot
  return root ? `inside the workspace ${root}` : 'inside the workspace'
}

export type ApprovalAssist = {
  readonly decision: Decision<ToolApprovalOutcome>
  readonly actionHash: string
  readonly authorizationVersion: string
}

export type ApprovalAssistAllow = NonNullable<ReturnType<typeof approvalAssistDecision>> & {
  // INVARIANT: Ledger row of the adopted verdict, for the permission outcome comparison.
  readonly decisionLedgerId?: string | undefined
}

export async function evaluateApprovalAssist(
  decisions: DecisionService | null | undefined,
  db: Pick<AgentDatabase, 'sqlite'>,
  invocation: ToolInvocation,
  options: { signal?: AbortSignal | undefined; cwd?: string | undefined } = {},
): Promise<ApprovalAssist | null> {
  if (!autoReviewAssistEligible(invocation)) return null
  if (invocation.permissionFacts?.risk === 'critical') return null
  const engine = await decisions?.ensureEngine(options.cwd).catch(() => null)
  if (!engine) return null
  if (engine.getMode(toolApprovalSpec.id) === 'off') return null
  const actionHash = guardianActionHash(invocation)
  const authorizationVersion = guardianAuthorizationVersion(db, invocation.threadID)
  const command = invocation.input.command
  const frame = taskFrameOf(invocation.threadID)
  const taskSummary = invocation.input.taskSummary ?? invocation.input.goal
  const decision = await engine.decide(
    toolApprovalSpec,
    {
      call: secretScrubber.scrubText(approvalCallText(invocation)),
      where: approvalWhere(invocation),
      task: secretScrubber.scrubText(
        [frame?.goal, typeof taskSummary === 'string' ? taskSummary : '']
          .filter(Boolean)
          .join('\n')
          .slice(0, 4_000),
      ),
      userMessage: realUserMessages(db, invocation.threadID),
      check: typeof command === 'string' && isCheckCommand(command),
    },
    {
      signal: options.signal,
      origin: { threadId: invocation.threadID, turnId: invocation.turnID },
    },
  )
  return { decision, actionHash, authorizationVersion }
}

export function approvalAssistDecision(
  db: Pick<AgentDatabase, 'sqlite'>,
  invocation: ToolInvocation,
  assist: ApprovalAssist,
) {
  const { decision } = assist
  if (decision.mode !== 'active' || decision.source !== 'judge') return null
  if (decision.outcome !== 'approve') return null
  // SAFETY: an allow is only valid for the exact action and authorization snapshot the judge saw.
  if (guardianActionHash(invocation) !== assist.actionHash) return null
  if (guardianAuthorizationVersion(db, invocation.threadID) !== assist.authorizationVersion)
    return null
  return {
    decision: 'allow' as const,
    risk: 'low' as const,
    reason: 'Judge 判定该调用为任务所需步骤（tool.approval），已绑定动作指纹与授权版本放行',
    guardian: guardianReview({
      status: 'completed',
      source: 'model',
      risk: 'low',
      userAuthorization: 'medium',
      confidence: 'high',
      categories: [],
      rationale: 'tool.approval 高置信判定为任务所需步骤，用户授权版本未变化。',
      authorizationVersion: assist.authorizationVersion,
    }),
  }
}

export async function evaluateConstraintCheck(
  decisions: DecisionService | null | undefined,
  invocation: ToolInvocation,
  options: {
    constraints?: readonly string[] | undefined
    signal?: AbortSignal | undefined
    cwd?: string | undefined
  } = {},
): Promise<Decision<{ readonly broken: readonly number[] }> | null> {
  const capabilities = invocation.toolPolicy?.capabilities
  const sideEffecting =
    capabilities !== undefined &&
    (capabilities.readOnly !== true ||
      capabilities.process ||
      capabilities.externalState ||
      capabilities.filesystem === 'workspace-write' ||
      capabilities.filesystem === 'host-write')
  if (!sideEffecting) return null
  const constraints =
    options.constraints ?? taskFrameOf(invocation.threadID)?.constraints ?? []
  if (constraints.length === 0) return null
  const engine = await decisions?.ensureEngine(options.cwd).catch(() => null)
  if (!engine) return null
  if (engine.getMode(toolConstraintSpec.id) === 'off') return null
  return engine.decide(
    toolConstraintSpec,
    {
      toolName: invocation.name,
      call: secretScrubber.scrubText(approvalCallText(invocation)).slice(0, 4_000),
      constraints,
    },
    {
      signal: options.signal,
      origin: { threadId: invocation.threadID, turnId: invocation.turnID },
    },
  )
}

/** Browser target metadata supplied by BrowserService for `browser.action.risk`. */
export type BrowserActionTargetContext = {
  readonly url: string | null
  readonly title: string | null
  readonly targetText: string | null
}

/** Whether a `BrowserAction` call is eligible for `browser.action.risk` screening. */
export function browserActionRiskEligible(invocation: ToolInvocation): boolean {
  if (invocation.name !== 'BrowserAction') return false
  if (isReadOnlyTaskMode(invocation.taskMode)) return false
  if (isFullAccessPermissionConfig(invocation.permissionConfig)) return false
  if (invocation.permissionConfig.approvalsReviewer !== 'auto_review') return false
  if (invocation.permissionConfig.approvalPolicy !== 'auto_review') return false
  const facts = invocation.permissionFacts
  if (facts?.denyReason || facts?.hookRequiresApproval || facts?.forcedApproval) return false
  if (facts?.ruleEffect === 'ask' || facts?.ruleEffect === 'deny') return false
  return true
}

/**
 * Evaluates whether a state-changing `BrowserAction` on the auto-review path
 * risks an irreversible external side effect not explicitly asked for by the user.
 * SAFETY: never runs under `full-access` or read-only modes, and never relaxes denials.
 */
export async function evaluateBrowserActionRisk(
  decisions: DecisionService | null | undefined,
  invocation: ToolInvocation,
  input: {
    targetContext: BrowserActionTargetContext | null
    userMessage: string
  },
  options: { signal?: AbortSignal | undefined; cwd?: string | undefined } = {},
): Promise<Decision<BrowserActionRiskOutcome> | null> {
  if (!browserActionRiskEligible(invocation)) return null
  const operation = invocation.input.operation as
    | {
        action?: unknown
        text?: unknown
        key?: unknown
        accept?: unknown
        target?: { selector?: unknown; ref?: unknown }
      }
    | undefined
  if (!operation || !isBrowserRiskAction(operation.action)) return null
  const engine = await decisions?.ensureEngine(options.cwd).catch(() => null)
  if (!engine) return null
  if (engine.getMode(browserActionRiskSpec.id) === 'off') return null

  const fallbackTarget =
    typeof operation.target?.selector === 'string' && operation.target.selector.trim()
      ? operation.target.selector.trim()
      : typeof operation.target?.ref === 'string' && operation.target.ref.trim()
        ? `ref=${operation.target.ref.trim()}`
        : operation.action === 'dialog'
          ? `dialog(accept=${String(operation.accept ?? false)})`
          : operation.action === 'key' && typeof operation.key === 'string'
            ? `key=${operation.key}`
            : operation.action
  const targetText = input.targetContext?.targetText?.trim() || fallbackTarget
  const rawPreview =
    typeof operation.text === 'string'
      ? operation.text
      : typeof operation.key === 'string'
        ? operation.key
        : ''

  return engine.decide(
    browserActionRiskSpec,
    {
      action: operation.action,
      url: secretScrubber.scrubText(input.targetContext?.url ?? invocation.authorizationScope?.browserOrigin ?? '').slice(0, 500),
      title: secretScrubber.scrubText(input.targetContext?.title ?? '').slice(0, 300),
      target: secretScrubber.scrubText(targetText).slice(0, 400),
      textPreview: redactBrowserInputPreview(rawPreview, targetText),
      userMessage: input.userMessage,
    },
    {
      signal: options.signal,
      origin: { threadId: invocation.threadID, turnId: invocation.turnID },
    },
  )
}