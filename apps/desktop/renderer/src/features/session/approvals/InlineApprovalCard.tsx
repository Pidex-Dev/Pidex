import { APP_ICON_SIZES } from '../../../components/ui/IconTokens.js'
import React from 'react'
import { decodeThreadPatchDiff } from '@pidex/agent-protocol'
import { FileMutationDiffBody } from '../timeline/FileMutationDiffBody.js'
import { CanonicalCommandBlock } from '../timeline/ToolCommandCard.js'
import { ArrowRight, PenLine, X } from 'lucide-react'
import type {
  DesktopPermissionDecision,
  DesktopPermissionGrantScope,
  DesktopPermissionMode,
  DesktopPermissionRequest,
} from '../../../../shared/Types.js'
import { Button } from '../../../components/ui/Button.js'
import { AskUserQuestionApproval } from './AskUserQuestionApproval.js'
import { useQuestionSkipCapability } from './UseQuestionSkipCapability.js'
import { ASK_USER_QUESTION_NAV_BUTTON_CLASS, RequestCard } from './RequestCard.js'
import { ConfirmationDialog } from '../../../components/ui/ConfirmationDialog.js'
import { useApprovalCapability } from './UseQuestionSkipCapability.js'
import {
  McpElicitationForm,
  McpElicitationUnsupported,
} from '../mcpElicitation/McpElicitationForm.js'
import { getSchemaMode, parseMcpElicitationSchema } from '../mcpElicitation/McpElicitationUtils.js'
import { GuardianReviewSummary } from './GuardianReviewSummary.js'
import { cx } from '../../../utils/Cx.js'

export type InlineApprovalCommand = {
  full: string
  hint: string
}

export type PermissionGrantScopeOption = {
  scope: DesktopPermissionGrantScope
  label: string
}

export const PERMISSION_GRANT_SCOPE_LABELS: Record<DesktopPermissionGrantScope, string> = {
  'tool-call': '仅此次工具调用',
  turn: '当前轮次',
  session: '当前任务会话',
}

export function permissionGrantScopeOptions(
  request: DesktopPermissionRequest,
): PermissionGrantScopeOption[] {
  const grant = request.permissionGrant
  const allowedScopes = grant?.allowedScopes ?? []
  const scopes =
    allowedScopes.length > 0 ? allowedScopes : grant?.requestedScope ? [grant.requestedScope] : []
  return scopes.map((scope) => ({ scope, label: PERMISSION_GRANT_SCOPE_LABELS[scope] }))
}

export function permissionGrantDefaultScope(
  options: PermissionGrantScopeOption[],
  requestedScope: DesktopPermissionGrantScope | undefined,
): DesktopPermissionGrantScope | null {
  return (
    options.find((option) => option.scope === requestedScope)?.scope ?? options[0]?.scope ?? null
  )
}

export function permissionGrantGroups(
  request: DesktopPermissionRequest,
): Array<{ title: string; items: string[] }> {
  const requested = request.permissionGrant?.requestedPermissions
  const groups: Array<{ title: string; items: string[] }> = []
  if (requested) {
    const readPaths = stringArrayValue(requested.readPaths)
    const writePaths = stringArrayValue(requested.writePaths)
    const networkDomains = stringArrayValue(requested.networkDomains)
    if (readPaths.length > 0) groups.push({ title: '读取路径', items: readPaths })
    if (writePaths.length > 0) groups.push({ title: '写入路径', items: writePaths })
    if (networkDomains.length > 0) groups.push({ title: '网络域名', items: networkDomains })
  }
  if (groups.length === 0) {
    const paths = Array.isArray(request.input.paths)
      ? request.input.paths.filter((item): item is string => typeof item === 'string')
      : []
    if (paths.length > 0) groups.push({ title: '涉及范围', items: paths })
  }
  return groups
}

export type InlineApprovalCardProps = {
  identity?: string
  disabledReason?: string
  workspacePath?: string | null
  scopedGrantsAvailable?: boolean
  onInterrupt?: () => void | Promise<void>
  request: DesktopPermissionRequest
  currentPermissionMode?: DesktopPermissionMode
  /** 所属 Turn 的 canonical 模式：Chat、Plan、Grill 共用逐题显式确认。 */
  taskMode?: 'chat' | 'plan' | 'grill'
  onDecide: (
    request: DesktopPermissionRequest,
    behavior: 'allow' | 'deny',
    alwaysAllow?: boolean,
    updatedInput?: Record<string, unknown>,
    decisionExtras?: Pick<
      DesktopPermissionDecision,
      'grantScope' | 'computerGrant' | 'grantOptionId'
    >,
  ) => void | Promise<void>
}

const COMMAND_HINT_MAX_LENGTH = 56

export function InlineApprovalCard({
  request,
  currentPermissionMode,
  taskMode,
  onDecide,
  onInterrupt,
  identity,
  disabledReason,
  workspacePath,
  scopedGrantsAvailable,
}: InlineApprovalCardProps): React.ReactNode {
  const supportsQuestionSkip = useQuestionSkipCapability(
    request.requestId,
    request.toolName === 'AskUserQuestion',
  )
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [confirmGrant, setConfirmGrant] = React.useState<
    NonNullable<DesktopPermissionRequest['grantOptions']>[number] | null
  >(null)
  const probedScopedGrants = useApprovalCapability(
    request.requestId,
    scopedGrantsAvailable === undefined,
    'interaction.scopedGrants.v1',
  )
  const hasScopedGrants = scopedGrantsAvailable ?? probedScopedGrants
  const grantOptions = hasScopedGrants ? (request.grantOptions ?? []) : []
  const requestIdRef = React.useRef(request.requestId)
  requestIdRef.current = request.requestId
  const busyRef = React.useRef(false)
  const disabled = busy || Boolean(disabledReason)
  const [detailsOpen, setDetailsOpen] = React.useState(false)
  const isPermissionGrant =
    request.requestKind === 'permission-grant' || Boolean(request.permissionGrant)
  const scopeOptions = permissionGrantScopeOptions(request)
  const defaultScope = permissionGrantDefaultScope(
    scopeOptions,
    request.permissionGrant?.requestedScope,
  )
  const defaultOptionId = request.computerApp
    ? 'computer-chat'
    : isPermissionGrant
      ? defaultScope
        ? `scope:${defaultScope}`
        : ''
      : 'allow-once'
  const [selectedOptionId, setSelectedOptionId] = React.useState<string>(defaultOptionId)
  const [feedback, setFeedback] = React.useState('')
  React.useEffect(() => {
    // A fresh permission request must not inherit the scope chosen for the
    // previous one rendered by the same card instance.
    setSelectedOptionId(defaultOptionId)
    setFeedback('')
    busyRef.current = false
    setBusy(false)
    setError(null)
    setConfirmGrant(null)
    setDetailsOpen(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.requestId])
  const command = buildInlineApprovalCommand(request)
  const approvalTitle = request.computerApp
    ? `允许使用 ${request.computerApp.name}？`
    : inlineApprovalTitle(request, workspacePath)
  const showDescription = shouldShowApprovalDescription(request.description, approvalTitle)
  const reviewSummary = inlineApprovalReviewSummary(request)
  const fileDiffs =
    !request.toolIdentity && Array.isArray(request.input.approvalFileDiffs)
      ? request.input.approvalFileDiffs.flatMap((value) => {
          try {
            return [decodeThreadPatchDiff(value)]
          } catch {
            return []
          }
        })
      : []
  const guardianSummary = request.guardian ? (
    <GuardianReviewSummary
      review={request.guardian}
      {...(request.autoReviewFallbackReason
        ? { fallbackReason: request.autoReviewFallbackReason }
        : {})}
    />
  ) : request.autoReviewFallbackReason ? (
    <p className="inline-approval-target tw:m-0 tw:text-app-text-soft tw:type-1 tw:wrap-anywhere">
      自动审查无法完成，已转为人工审批：{request.autoReviewFallbackReason}
    </p>
  ) : null
  async function act(action: () => void | Promise<void>): Promise<void> {
    if (busyRef.current || disabledReason) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    const activeId = request.requestId
    try {
      await action()
    } catch {
      if (requestIdRef.current === activeId) {
        setError('操作失败，请重试。')
        busyRef.current = false
        setBusy(false)
      }
    }
  }
  const navigation = onInterrupt ? (
    <button
      type="button"
      className={ASK_USER_QUESTION_NAV_BUTTON_CLASS}
      aria-label="中断当前对话"
      disabled={disabled}
      onClick={() => void act(onInterrupt)}
    >
      <X className="tw:size-icon-sm" size={APP_ICON_SIZES.sm} />
    </button>
  ) : null
  type ApprovalOption = {
    id: string
    label: string
    disabled?: boolean
    run: () => void
  }

  const approvalOptions: ApprovalOption[] = request.computerApp
    ? [
        {
          id: 'computer-chat',
          label: '允许此对话',
          run: () =>
            void act(() =>
              onDecide(request, 'allow', false, undefined, { computerGrant: 'chat' }),
            ),
        },
        ...(request.computerApp.allowPersistentApproval
          ? [
              {
                id: 'computer-persistent',
                label: '始终允许',
                run: () =>
                  void act(() =>
                    onDecide(request, 'allow', false, undefined, { computerGrant: 'persistent' }),
                  ),
              },
            ]
          : []),
      ]
    : isPermissionGrant
      ? scopeOptions.length > 0
        ? scopeOptions.map((option) => ({
            id: `scope:${option.scope}`,
            label: `允许（${option.label}）`,
            run: () =>
              void act(() =>
                onDecide(request, 'allow', false, undefined, { grantScope: option.scope }),
              ),
          }))
        : [
            {
              id: 'grant-empty',
              label: '允许',
              disabled: true,
              run: () => {},
            },
          ]
      : [
          {
            id: 'allow-once',
            label: '是',
            run: () => void act(() => onDecide(request, 'allow')),
          },
          ...[
            ...grantOptions.filter((option) => option.scope === 'session'),
            ...grantOptions.filter((option) => option.scope !== 'session'),
          ].map((option) => ({
            id: `grant:${option.id}`,
            label: formatGrantOptionLabel(option),
            run: () => {
              if (option.requiresConfirmation) {
                setConfirmGrant(option)
                return
              }
              void act(() =>
                onDecide(request, 'allow', false, undefined, { grantOptionId: option.id }),
              )
            },
          })),
        ]

  const trimmedFeedback = feedback.trim()
  const isCustomDeny = trimmedFeedback.length > 0
  const activeOption =
    approvalOptions.find((option) => option.id === selectedOptionId) ?? approvalOptions[0]

  function handleOptionClick(option: ApprovalOption): void {
    if (disabled || option.disabled) return
    if (!isCustomDeny && activeOption?.id === option.id) {
      option.run()
      return
    }
    setSelectedOptionId(option.id)
    setFeedback('')
  }

  function submitOptionOrDenyFeedback(): void {
    if (disabled) return
    if (isCustomDeny) {
      void act(() => onDecide(request, 'deny', false, { feedback: trimmedFeedback }))
      return
    }
    if (activeOption && !activeOption.disabled) {
      activeOption.run()
    }
  }

  function handleOptionsKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (disabled) return
    if (
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229 ||
      event.repeat
    ) {
      return
    }
    if (event.target instanceof HTMLTextAreaElement) return
    if (!event.ctrlKey && !event.metaKey && !event.altKey && /^[1-9]$/u.test(event.key)) {
      const option = approvalOptions[Number(event.key) - 1]
      if (option && !option.disabled) {
        event.preventDefault()
        handleOptionClick(option)
      }
      return
    }
    if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      approvalOptions.length > 1
    ) {
      event.preventDefault()
      const currentIndex = Math.max(
        0,
        approvalOptions.findIndex((option) => option.id === activeOption?.id),
      )
      const delta = event.key === 'ArrowUp' ? -1 : 1
      const nextIndex = (currentIndex + delta + approvalOptions.length) % approvalOptions.length
      const nextOption = approvalOptions[nextIndex]
      if (nextOption && !nextOption.disabled) {
        setSelectedOptionId(nextOption.id)
        setFeedback('')
      }
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      submitOptionOrDenyFeedback()
    }
  }

  const actions = (
    <div
      className="ask-user-question-stage tw:flex tw:flex-col tw:gap-1"
      onKeyDown={handleOptionsKeyDown}
    >
      <div
        className="ask-user-question-options tw:flex tw:flex-col tw:gap-1"
        role="radiogroup"
        aria-label={approvalTitle}
      >
        {approvalOptions.map((option, index) => {
          const selected = !isCustomDeny && activeOption?.id === option.id
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled || option.disabled}
              className={cx('ask-user-question-option-row', selected && 'is-selected')}
              onClick={() => handleOptionClick(option)}
            >
              <span
                className="request-card-marker ask-user-question-option-num"
                aria-hidden="true"
              >
                {index + 1}
              </span>
              <span className="ask-user-question-option-inline tw:flex tw:min-w-0 tw:flex-1 tw:flex-col tw:gap-1">
                <span className="ask-user-question-option-head tw:flex tw:flex-wrap tw:items-center tw:gap-2">
                  <span className="ask-user-question-option-title tw:type-2 tw:weight-medium tw:text-app-text tw:wrap-anywhere">
                    {option.label}
                  </span>
                </span>
              </span>
              <ArrowRight
                className="ask-user-question-row-arrow tw:size-icon-sm tw:shrink-0"
                size={APP_ICON_SIZES.sm}
                aria-hidden="true"
              />
            </button>
          )
        })}
      </div>
      <div className="ask-user-question-pill-row tw:mt-1">
        <span className="request-card-marker ask-user-question-pill-badge" aria-hidden="true">
          <PenLine className="tw:size-icon-xs" size={APP_ICON_SIZES.sm} />
        </span>
        <textarea
          className="ask-user-question-custom-input tw:block tw:w-full tw:min-w-0 tw:flex-1 tw:field-sizing-content tw:min-h-[1.5em] tw:max-h-[120px] tw:resize-none tw:overflow-y-auto tw:border-0 tw:bg-transparent tw:p-0 tw:text-app-text tw:type-2 tw:weight-regular tw:wrap-anywhere tw:outline-none tw:placeholder:text-app-text-meta"
          aria-label="拒绝并告知 Pidex 如何调整"
          placeholder="否，请告知 Pidex 如何调整"
          rows={1}
          disabled={disabled}
          value={feedback}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            if (event.shiftKey && !event.ctrlKey && !event.metaKey) return
            if (event.altKey) return
            if (
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229 ||
              event.repeat
            ) {
              return
            }
            event.preventDefault()
            if (feedback.trim()) submitOptionOrDenyFeedback()
          }}
          onChange={(event) => setFeedback(event.target.value)}
        />
        <div className="ask-user-question-pill-actions tw:flex tw:shrink-0 tw:items-center tw:gap-1">
          <Button
            type="button"
            shape="pill"
            size="sm"
            color="secondary"
            disabled={disabled}
            onClick={() => void act(() => onDecide(request, 'deny'))}
          >
            忽略
          </Button>
          <Button
            type="button"
            shape="pill"
            size="sm"
            color="primary"
            disabled={disabled || (!isCustomDeny && Boolean(activeOption?.disabled))}
            loading={busy}
            loadingText="提交中…"
            onClick={submitOptionOrDenyFeedback}
          >
            提交
          </Button>
        </div>
      </div>
      <ConfirmationDialog
        open={confirmGrant !== null}
        title="允许访问所有网站？"
        description="Agent 将能够读取和操作所有网站。明确拒绝的网站仍会被阻止，你可以在浏览器授权设置中撤销。"
        actionLabel="允许所有网站"
        actionDisabled={disabled}
        onCancel={() => {
          if (!busy) setConfirmGrant(null)
        }}
        onAction={() => {
          if (confirmGrant)
            void act(async () => {
              await onDecide(request, 'allow', false, undefined, { grantOptionId: confirmGrant.id })
              setConfirmGrant(null)
            })
        }}
      />
    </div>
  )

  if (request.computerApp) {
    return (
      <RequestCard
        title={approvalTitle}
        variant="permission"
        identity={identity}
        disabledReason={disabledReason}
        navigation={navigation}
        error={error}
      >
        <p className="inline-approval-target tw:m-0 tw:text-app-text-soft tw:type-1 tw:wrap-anywhere">
          截图会进入聊天，必要时可能切到前台。你可以随时停止操作。
        </p>
        {actions}
      </RequestCard>
    )
  }
  if (request.toolName === 'AskUserQuestion') {
    return (
      <AskUserQuestionApproval
        supportsQuestionSkip={supportsQuestionSkip}
        taskMode={taskMode}
        identity={identity}
        disabledReason={disabledReason}
        onInterrupt={onInterrupt}
        request={request}
        onReject={() => onDecide(request, 'deny')}
        onSubmit={(updatedInput) => onDecide(request, 'allow', false, updatedInput)}
      />
    )
  }

  if (request.toolName === 'McpElicitation') {
    const elicitationRequest = request.input?.request as Record<string, unknown> | undefined
    const serverName = (request.input?.serverName as string) ?? '未知服务器'
    const message = (elicitationRequest?.message as string) ?? ''
    const mode = getSchemaMode(elicitationRequest)

    if (mode === 'form') {
      const schema = parseMcpElicitationSchema(elicitationRequest?.requestedSchema)
      if (schema) {
        return (
          <McpElicitationForm
            key={request.requestId}
            busy={disabled}
            error={error}
            details={elicitationConfirmationDetails(elicitationRequest?.presentation)}
            serverName={serverName}
            message={message}
            schema={schema}
            onSubmit={(content) => void act(() => onDecide(request, 'allow', false, { content }))}
            onDecline={() => void act(() => onDecide(request, 'deny'))}
            onCancel={() =>
              void act(() =>
                onDecide(request, 'deny', false, {
                  cancelled: true,
                  action: 'cancel',
                }),
              )
            }
          />
        )
      }
    }

    // Fallback: unsupported mode
    return (
      <McpElicitationUnsupported
        busy={disabled}
        error={error}
        serverName={serverName}
        message={message}
        onDecline={() => void act(() => onDecide(request, 'deny'))}
        onCancel={() =>
          void act(() =>
            onDecide(request, 'deny', false, {
              cancelled: true,
              action: 'cancel',
            }),
          )
        }
      />
    )
  }

  if (isPermissionGrant) {
    const permissionGroups = permissionGrantGroups(request)
    return (
      <RequestCard
        title="需要额外权限，是否允许？"
        variant="permission-grant"
        identity={identity}
        disabledReason={disabledReason}
        error={error}
        navigation={navigation}
      >
        {request.description ? (
          <p className="inline-approval-target tw:m-0 tw:text-app-text-soft tw:type-1 tw:wrap-anywhere">
            {request.description}
          </p>
        ) : null}
        {guardianSummary}
        {reviewSummary ? (
          <p className="inline-approval-target tw:m-0 tw:text-app-text-soft tw:type-1 tw:wrap-anywhere">
            {reviewSummary}
          </p>
        ) : null}
        {permissionGroups.length > 0 ? (
          <div className="inline-approval-permission-grant tw:grid tw:gap-2">
            {permissionGroups.map((group) => (
              <div className="inline-approval-permission-group tw:grid tw:gap-1" key={group.title}>
                <span className="inline-approval-permission-group-title tw:text-app-text-soft tw:type-1 tw:weight-medium">
                  {group.title}
                </span>
                <ul className="inline-approval-permission-group-items tw:m-0 tw:grid tw:list-none tw:gap-1 tw:rounded-4 tw:bg-app-editor tw:px-3 tw:py-2 tw:text-app-text-soft tw:type-code tw:break-all">
                  {group.items.map((item) => (
                    <li className="tw:min-w-0 tw:truncate" key={item}>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : null}
        {actions}
      </RequestCard>
    )
  }

  return (
    <RequestCard
      title={approvalTitle}
      variant="permission"
      identity={identity}
      disabledReason={disabledReason}
      error={error}
      navigation={navigation}
    >
      {showDescription ? (
        <p className="inline-approval-target tw:m-0 tw:text-app-text-soft tw:type-1 tw:wrap-anywhere">
          {request.description}
        </p>
      ) : null}
      {guardianSummary}
      {reviewSummary ? (
        <p className="inline-approval-target tw:m-0 tw:text-app-text-soft tw:type-1 tw:wrap-anywhere">
          {reviewSummary}
        </p>
      ) : null}

      {fileDiffs.map((diff) => (
        <details key={diff.path} className="request-card-content">
          <summary>{diff.path} · 查看修改差异</summary>
          <FileMutationDiffBody diff={diff} diffMarkerStyle="color" />
        </details>
      ))}

      {request.toolIdentity ? (
        <div className="request-card-content">
          <p className="request-card-identity tw:m-0 tw:text-app-text-soft tw:type-1">
            {request.toolIdentity.server} / {request.toolIdentity.tool}
          </p>
          {Object.entries(request.toolInput ?? {})
            .slice(0, 4)
            .map(([key, value]) => (
              <div key={key}>
                <span>{key}</span>
                <code className="inline-approval-command tw:block tw:w-full tw:min-w-0 tw:overflow-auto tw:bg-transparent tw:p-0 tw:text-app-text-soft tw:type-code tw:whitespace-pre-wrap tw:break-all">
                  {typeof value === 'string' ? value : JSON.stringify(value)}
                </code>
              </div>
            ))}
          <Button shape="pill" size="sm" color="secondary" onClick={() => setDetailsOpen(true)}>
            查看全部参数
          </Button>
        </div>
      ) : (
        <div className="canonical-command-shell canonical-command-card">
          <CanonicalCommandBlock
            key={request.requestId}
            command={command.full}
            showPrompt={isCommandPermission(request)}
            codeClassName="inline-approval-command"
          />
        </div>
      )}

      <ConfirmationDialog
        open={detailsOpen}
        title="工具参数"
        actionLabel="关闭"
        onAction={() => setDetailsOpen(false)}
        onCancel={() => setDetailsOpen(false)}
        description={
          <pre className="inline-approval-command tw:block tw:w-full tw:min-w-0 tw:overflow-auto tw:bg-transparent tw:p-0 tw:text-app-text-soft tw:type-code tw:whitespace-pre-wrap tw:break-all">
            {JSON.stringify(request.toolInput ?? request.input, null, 2)}
          </pre>
        }
      />

      {actions}
    </RequestCard>
  )
}

const REDUNDANT_APPROVAL_DESCRIPTIONS = new Set([
  '命令或 cwd 指向工作区外路径',
  '检测到风险或工作区外操作，需要批准',
])

function shouldShowApprovalDescription(
  description: string | null | undefined,
  approvalTitle: string,
): boolean {
  const trimmed = description?.trim() ?? ''
  if (!trimmed || trimmed === approvalTitle) return false
  return !REDUNDANT_APPROVAL_DESCRIPTIONS.has(trimmed)
}

export function formatGrantOptionLabel(
  option: NonNullable<DesktopPermissionRequest['grantOptions']>[number],
): string {
  if (option.label === '在此会话中允许（当前项目）') return '是，且本次会话不再询问'
  if (option.label === '始终允许（当前项目）') return '是，且当前项目不再询问'
  return option.label
}

function inlineApprovalTitle(
  request: DesktopPermissionRequest,
  workspacePath?: string | null,
): string {
  if (request.toolIdentity) {
    return `允许 ${request.toolIdentity.server} / ${request.toolIdentity.tool}？`
  }
  const outsideWorkspace = isOutsideWorkspaceRequest(request)
  const scopePrefix = outsideWorkspace ? '工作区外的 ' : ''

  if (isCommandPermission(request)) {
    const cwd = stringValue(request.input.cwd)
    const rawCommand = stringValue(request.input.command) ?? stringValue(request.input.cmd)
    const externalPaths = extractExternalCommandPaths(rawCommand, workspacePath, cwd)
    const externalDir = externalPaths[0] ? externalDirectoryLabel(externalPaths[0]) : null
    const baseScope = workspacePath?.trim() || null
    const cwdOutside = Boolean(cwd && (baseScope ? !isPathInsideBase(cwd, baseScope) : !externalDir))

    if (externalDir) {
      const cmdLabel = summarizeCommandForTitle(rawCommand, externalDir)
      return `需要在工作区外的 ${externalDir} 目录${cmdLabel ? `运行 ${cmdLabel}` : '运行命令'}，是否允许执行？`
    }

    const cmdLabel = summarizeCommandForTitle(rawCommand, null)
    if (cwd) {
      const dirPrefix = outsideWorkspace && cwdOutside ? '工作区外的 ' : ''
      return `需要在${dirPrefix}${cwd} 目录${cmdLabel ? `运行 ${cmdLabel}` : '运行命令'}，是否允许执行？`
    }
    return `需要${outsideWorkspace ? '在工作区外' : ''}运行${cmdLabel ? ` ${cmdLabel}` : '命令'}，是否允许执行？`
  }

  const affectedPaths = inlineApprovalAffectedPaths(request)
  if (affectedPaths.length === 1) {
    const entry = affectedPaths[0]
    const verb =
      entry.operation === 'create' ? '创建' : entry.operation === 'delete' ? '删除' : '修改'
    return formatPathActionTitle(entry.path, verb, scopePrefix, outsideWorkspace)
  }
  if (affectedPaths.length > 1) {
    const verb = affectedPaths.every((item) => item.operation === 'create')
      ? '创建'
      : affectedPaths.every((item) => item.operation === 'delete')
        ? '删除'
        : '修改'
    const sharedDir = commonParentDirectory(affectedPaths.map((item) => item.path))
    if (sharedDir) {
      return `需要在${scopePrefix}${sharedDir} 目录${verb} ${affectedPaths.length} 个文件，是否允许执行？`
    }
    return `需要${outsideWorkspace ? '在工作区外' : ''}${verb} ${affectedPaths.length} 个文件，是否允许执行？`
  }

  const filePath = stringValue(request.input.file_path) ?? stringValue(request.input.filePath)
  if (filePath) {
    const verb =
      request.toolName === 'Write' ? '创建' : request.toolName === 'Read' ? '读取' : '修改'
    return formatPathActionTitle(filePath, verb, scopePrefix, outsideWorkspace)
  }

  const paths = stringArrayValue(request.input.paths).filter((item) => item.trim().length > 0)
  if (paths.length === 1) {
    return formatPathActionTitle(paths[0], '访问', scopePrefix, outsideWorkspace)
  }
  if (paths.length > 1) {
    return `需要${outsideWorkspace ? '在工作区外' : ''}访问 ${paths.length} 个路径，是否允许执行？`
  }

  return request.description
}

function isOutsideWorkspaceRequest(request: DesktopPermissionRequest): boolean {
  const description = request.description ?? ''
  return (
    description.includes('工作区外') ||
    description.includes('工作区之外') ||
    description.includes('scope_escape') ||
    request.input.externalWrite === true ||
    request.input.externalCommand === true
  )
}

function normalizePathForCompare(rawPath: string): string {
  const unified = rawPath.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:/i.test(unified) ? unified.toLowerCase() : unified
}

function isPathInsideBase(targetPath: string, basePath: string | null | undefined): boolean {
  if (!basePath) return false
  const target = normalizePathForCompare(targetPath)
  const base = normalizePathForCompare(basePath)
  if (!target || !base) return false
  return target === base || target.startsWith(`${base}/`)
}

function extractExternalCommandPaths(
  command: string | null,
  workspacePath?: string | null,
  cwd?: string | null,
): string[] {
  if (!command) return []
  const candidates: string[] = []
  const patterns = [
    /'([a-zA-Z]:[\\/][^'\r\n]+)'/g,
    /"([a-zA-Z]:[\\/][^"\r\n]+)"/g,
    /'(\/(?:[^'\r\n/]+\/)*[^'\r\n]+)'/g,
    /"(\/(?:[^"\r\n/]+\/)*[^"\r\n]+)"/g,
    /(?:^|[\s=])([a-zA-Z]:[\\/][^\s"'|;&<>()\r\n]+)/g,
  ]
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      const cleaned = match[1]?.trim().replace(/[\\/]+$/, '')
      if (cleaned && !/^[a-zA-Z]:$/.test(cleaned)) {
        candidates.push(cleaned)
      }
    }
  }
  const referenceBase = workspacePath?.trim() || cwd?.trim() || null
  const seen = new Set<string>()
  const result: string[] = []
  for (const candidate of candidates) {
    const key = normalizePathForCompare(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    if (referenceBase && isPathInsideBase(candidate, referenceBase)) continue
    result.push(candidate)
  }
  return result
}

function externalDirectoryLabel(rawPath: string): string {
  const { dir, base } = splitDirectoryAndTarget(rawPath)
  if (dir && /\.[a-z0-9]{1,8}$/i.test(base)) {
    return dir
  }
  return rawPath.trim().replace(/[\\/]+$/, '')
}

function formatPathActionTitle(
  targetPath: string,
  verb: string,
  scopePrefix: string,
  outsideWorkspace: boolean,
): string {
  const { dir, base } = splitDirectoryAndTarget(targetPath)
  if (dir) {
    return `需要在${scopePrefix}${dir} 目录${verb} ${base}，是否允许执行？`
  }
  return `需要${outsideWorkspace ? '在工作区外' : ''}${verb} ${targetPath}，是否允许执行？`
}

function splitDirectoryAndTarget(rawPath: string): { dir: string | null; base: string } {
  const normalized = rawPath.trim().replace(/[\\/]+$/, '')
  const sepIndex = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  if (sepIndex <= 0) return { dir: null, base: normalized }
  const dir = normalized.slice(0, sepIndex)
  const base = normalized.slice(sepIndex + 1)
  if (!dir || dir === '.' || !base) return { dir: null, base: normalized }
  return { dir, base }
}

function commonParentDirectory(paths: string[]): string | null {
  const dirs = paths.map((item) => splitDirectoryAndTarget(item).dir)
  if (dirs.length === 0 || dirs.some((dir) => !dir)) return null
  const first = dirs[0]!
  return dirs.every((dir) => dir === first) ? first : null
}

function summarizeCommandForTitle(
  command: string | null,
  embeddedPath: string | null,
): string | null {
  if (!command) return null
  const trimmed = command.trim()
  if (!trimmed) return null
  if (!trimmed.includes('\n') && trimmed.length <= 40 && !(embeddedPath && trimmed.includes(embeddedPath))) {
    return trimmed
  }
  const headMatch = /^(?:&\s*)?(?:"([^"]+)"|'([^']+)'|([^\s|;&]+))/.exec(trimmed)
  const head = headMatch?.[1] ?? headMatch?.[2] ?? headMatch?.[3]
  if (!head || head.startsWith('$') || head.length > 40) return null
  return head
}

function elicitationConfirmationDetails(value: unknown): React.ReactNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const presentation = value as Record<string, unknown>
  if (presentation.type !== 'confirmation' || !Array.isArray(presentation.changes)) return null
  if (
    presentation.changes.some(
      (change) =>
        !change ||
        typeof change !== 'object' ||
        typeof (change as Record<string, unknown>).label !== 'string',
    )
  )
    return null
  return (
    <div className="request-card-content">
      {typeof presentation.title === 'string' ? <p>{presentation.title}</p> : null}
      {presentation.changes.map((raw, index) => {
        const change = raw as { label: string; before?: unknown; after?: unknown }
        return (
          <div key={index}>
            <strong>{change.label}</strong>
            {typeof change.before === 'string' ? (
              <pre className="inline-approval-command tw:block tw:w-full tw:min-w-0 tw:overflow-auto tw:bg-transparent tw:p-0 tw:text-app-text-soft tw:type-code tw:whitespace-pre-wrap tw:break-all">
                {change.before}
              </pre>
            ) : null}
            {typeof change.after === 'string' ? (
              <pre className="inline-approval-command tw:block tw:w-full tw:min-w-0 tw:overflow-auto tw:bg-transparent tw:p-0 tw:text-app-text-soft tw:type-code tw:whitespace-pre-wrap tw:break-all">
                {change.after}
              </pre>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function inlineApprovalReviewSummary(request: DesktopPermissionRequest): string | null {
  const value = request.input.reviewSummary
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const summary = value as Record<string, unknown>
  const fileCount = nonNegativeInteger(summary.fileCount)
  const hunkCount = nonNegativeInteger(summary.hunkCount)
  const additions = nonNegativeInteger(summary.additions)
  const deletions = nonNegativeInteger(summary.deletions)
  if (fileCount === null || hunkCount === null || additions === null || deletions === null)
    return null
  return `${fileCount} 个文件，${hunkCount} 个变更块，+${additions} -${deletions}`
}

function isCommandPermission(request: DesktopPermissionRequest): boolean {
  return (
    request.toolName === 'exec_command' ||
    request.toolName === 'Bash' ||
    request.toolName === 'PowerShell' ||
    stringValue(request.input.command) !== null ||
    stringValue(request.input.cmd) !== null
  )
}

export function buildInlineApprovalCommand(
  request: DesktopPermissionRequest,
): InlineApprovalCommand {
  const full = formatCommandLine(request)
  return {
    full,
    hint: truncateCommand(full, COMMAND_HINT_MAX_LENGTH),
  }
}

function formatCommandLine(request: DesktopPermissionRequest): string {
  const { toolName, input } = request
  const affectedPaths = inlineApprovalAffectedPaths(request)
  if (affectedPaths.length > 0) {
    return affectedPaths
      .map(
        ({ path, operation }) =>
          `${operation === 'create' ? '新增' : operation === 'delete' ? '删除' : '修改'} ${path}`,
      )
      .join('\n')
  }
  if (isCommandPermission(request)) {
    const commandText = stringValue(input.command) ?? stringValue(input.cmd)
    if (commandText) return commandText
  }
  if (toolName.toLowerCase() === 'apply_patch') {
    return 'apply_patch（未提供可展示的文件范围）'
  }
  const filePath = stringValue(input.file_path) ?? stringValue(input.filePath)
  const isFileTool =
    toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit' || toolName === 'Read'

  if (isFileTool) {
    return filePath ? `${toolName} ${filePath}` : toolName
  }

  const parts: string[] = [toolName]
  for (const [key, value] of Object.entries(input)) {
    if (key === 'file_path' || key === 'filePath') continue
    const flag = key.length === 1 ? `-${key}` : `-${key}`
    if (typeof value === 'string') {
      parts.push(`${flag} ${quoteIfNeeded(value)}`)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${flag} ${String(value)}`)
    } else if (value !== null && value !== undefined) {
      parts.push(`${flag} ${JSON.stringify(value)}`)
    }
  }
  return parts.join(' ')
}

function quoteIfNeeded(value: string): string {
  if (value === '') return "''"
  if (/[\s'"$`]/.test(value)) {
    return `'${value.replace(/'/g, "''")}'`
  }
  return value
}

function truncateCommand(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}…`
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function inlineApprovalAffectedPaths(
  request: DesktopPermissionRequest,
): Array<{ path: string; operation: 'create' | 'update' | 'delete' }> {
  const value = request.input.affectedPaths
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return []
    }
    const affected = candidate as Record<string, unknown>
    const path = stringValue(affected.path)
    const operation = affected.operation
    return path && (operation === 'create' || operation === 'update' || operation === 'delete')
      ? [{ path, operation }]
      : []
  })
}
