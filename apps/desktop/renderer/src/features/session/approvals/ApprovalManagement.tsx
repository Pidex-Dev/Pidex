import React from 'react'
import { AlertTriangle } from 'lucide-react'
import type { PermissionRule, PermissionRuleEffect } from '@pidex/shared/thread'
import { desktopClient } from '../../../services/desktop-client/index.js'
import { Button } from '../../../components/ui/Button.js'
import { ConfirmationDialog } from '../../../components/ui/ConfirmationDialog.js'
import { SearchInput } from '../../../components/ui/SearchInput.js'
import { SegmentedControl } from '../../../components/ui/SegmentedControl.js'
import { useApprovalCapability } from './UseQuestionSkipCapability.js'
import { ApprovalRuleEditor } from './ApprovalRuleEditor.js'
import {
  APPROVAL_RULE_EFFECT_TABS,
  approvalRuleEditorValuesFromRule,
  approvalRuleMatchSummary,
  approvalRuleScopeDescription,
  applyApprovalRuleRevoke,
  applyApprovalRuleUpsert,
  buildApprovalRuleInput,
  canEditApprovalRule,
  countApprovalRulesByEffect,
  createApprovalRuleEditorValues,
  filterApprovalRules,
  isApprovalRuleVersionConflict,
  type ApprovalRuleEditorValues,
} from './ApprovalRulesModel.js'
import { cx } from '../../../utils/Cx.js'

type ApprovalRuleEditorState = {
  mode: 'create' | 'edit'
  id?: string
  expectedVersion?: string
  values: ApprovalRuleEditorValues
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

/** Inline approval rules manager rendered inside Settings -> Permissions. */
export function ApprovalRulesPanel({
  workspacePath,
}: {
  workspacePath: string | null
}): React.ReactNode {
  const supported = useApprovalCapability('settings-permissions', true, 'permission.rules.v1')
  const hasWorkspace = Boolean(workspacePath?.trim())
  const workspaceRoots = React.useMemo(
    () => (workspacePath?.trim() ? [workspacePath.trim()] : []),
    [workspacePath],
  )
  const [rules, setRules] = React.useState<PermissionRule[]>([])
  const [tab, setTab] = React.useState<PermissionRuleEffect>('allow')
  const [query, setQuery] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [versionConflict, setVersionConflict] = React.useState(false)
  const [editor, setEditor] = React.useState<ApprovalRuleEditorState | null>(null)
  const [editorError, setEditorError] = React.useState<string | null>(null)
  const [pendingRevoke, setPendingRevoke] = React.useState<PermissionRule | null>(null)
  const loadGenerationRef = React.useRef(0)

  const loadRules = React.useCallback(async (): Promise<void> => {
    const generation = ++loadGenerationRef.current
    setLoading(true)
    setError('')
    setVersionConflict(false)
    try {
      const listed = await desktopClient.listApprovalRules(
        workspacePath?.trim() ? { cwd: workspacePath.trim() } : {},
      )
      if (generation !== loadGenerationRef.current) return
      const persistentRules = listed.rules.filter((rule) => rule.scope !== 'chat')
      setRules(persistentRules)
      // A refresh after a version conflict must resync the open editor's expected version.
      setEditor((current) => {
        if (!current?.id) return current
        const refreshed = persistentRules.find((rule) => rule.id === current.id)
        return refreshed ? { ...current, expectedVersion: refreshed.version } : current
      })
    } catch (cause) {
      if (generation === loadGenerationRef.current)
        setError(errorMessage(cause, '审批规则暂时不可用。'))
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false)
    }
  }, [workspacePath])

  React.useEffect(() => {
    setEditor(null)
    setEditorError(null)
    setPendingRevoke(null)
    setVersionConflict(false)
    setError('')
    if (supported) void loadRules()
    return () => {
      loadGenerationRef.current += 1
    }
  }, [supported, loadRules])

  const visibleRules = React.useMemo(
    () => filterApprovalRules(rules, tab, query),
    [rules, tab, query],
  )
  const counts = React.useMemo(() => countApprovalRulesByEffect(rules), [rules])

  const openCreate = (): void => {
    setEditorError(null)
    // A new edit session starts clean; a conflict banner from an abandoned one would mislead.
    setVersionConflict(false)
    setEditor({
      mode: 'create',
      values: createApprovalRuleEditorValues(tab, { scope: 'user' }),
    })
  }

  const openEdit = (rule: PermissionRule): void => {
    setEditorError(null)
    setVersionConflict(false)
    setEditor({
      mode: 'edit',
      id: rule.id,
      expectedVersion: rule.version,
      values: approvalRuleEditorValuesFromRule(rule),
    })
  }

  const saveRule = async (): Promise<void> => {
    if (!editor || busy) return
    const built = buildApprovalRuleInput(editor.values, {
      ...(editor.id ? { id: editor.id } : {}),
      isProjectChat: hasWorkspace,
    })
    if (!built.input) {
      setEditorError(built.error)
      return
    }
    setBusy(true)
    setEditorError(null)
    setError('')
    try {
      const result = await desktopClient.upsertApprovalRule({
        ...(workspacePath?.trim() ? { cwd: workspacePath.trim() } : {}),
        rule: built.input,
        ...(editor.expectedVersion ? { expectedVersion: editor.expectedVersion } : {}),
      })
      setRules((current) => applyApprovalRuleUpsert(current, result.rule))
      setTab(result.rule.effect)
      setEditor(null)
      setVersionConflict(false)
      await loadRules()
    } catch (cause) {
      if (isApprovalRuleVersionConflict(cause)) setVersionConflict(true)
      else setEditorError(errorMessage(cause, '保存审批规则失败，请重试。'))
    } finally {
      setBusy(false)
    }
  }

  const revokeRule = async (): Promise<void> => {
    if (!pendingRevoke || busy) return
    setBusy(true)
    setError('')
    try {
      await desktopClient.revokeApprovalRule({
        ...(workspacePath?.trim() ? { cwd: workspacePath.trim() } : {}),
        ruleId: pendingRevoke.id,
        ...(pendingRevoke.version ? { expectedVersion: pendingRevoke.version } : {}),
      })
      setRules((current) => applyApprovalRuleRevoke(current, pendingRevoke.id))
      if (editor?.id === pendingRevoke.id) setEditor(null)
      setPendingRevoke(null)
      // User/project rules share the configuration layer's version.
      await loadRules()
    } catch (cause) {
      if (isApprovalRuleVersionConflict(cause)) setVersionConflict(true)
      else setError(errorMessage(cause, '撤销审批规则失败，请重试。'))
      setPendingRevoke(null)
    } finally {
      setBusy(false)
    }
  }

  if (!supported) {
    return (
      <div className="tw:p-4">
        <p className="tw:m-0 tw:text-app-text-soft tw:type-1" role="status">
          正在确认审批规则能力…当前 Agent 需要协商 permission.rules.v1 才能管理规则。
        </p>
      </div>
    )
  }

  return (
    <div className="tw:grid tw:min-w-0 tw:gap-3 tw:p-4">
      <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-center tw:justify-between tw:gap-2">
        <SegmentedControl
          ariaLabel="审批规则效果"
          options={APPROVAL_RULE_EFFECT_TABS.map((entry) => ({
            value: entry.value,
            label: `${entry.label}（${counts[entry.value]}）`,
          }))}
          semantics="tabs"
          size="sm"
          value={tab}
          onChange={(value) => setTab(value as PermissionRuleEffect)}
        />
        <Button color="secondary" disabled={loading || busy} size="md" onClick={openCreate}>
          添加规则
        </Button>
      </div>
      <SearchInput
        aria-label="搜索审批规则"
        className="tw:min-w-0 tw:w-full"
        onChange={setQuery}
        placeholder="搜索工具、路径、命令、域名或服务器"
        value={query}
        variant="outlined"
      />
      {versionConflict ? (
        <div
          className="tw:flex tw:min-w-0 tw:items-center tw:gap-2 tw:rounded-control tw:border tw:border-app-border-subtle tw:bg-app-panel tw:p-2"
          role="alert"
        >
          <AlertTriangle
            aria-hidden="true"
            className="tw:shrink-0 tw:text-app-warning"
            size="var(--inline-icon-size, 1em)"
          />
          <span className="tw:min-w-0 tw:flex-1 tw:text-app-text-soft tw:type-1">
            规则已在其他位置更新，请刷新后重试。
          </span>
          <Button color="secondary" disabled={loading} size="sm" onClick={() => void loadRules()}>
            刷新规则
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className="tw:m-0 tw:text-app-danger tw:type-1" role="alert">
          {error}
        </p>
      ) : null}
      {editor ? (
        <ApprovalRuleEditor
          allowChatScope={false}
          busy={busy}
          error={editorError}
          isProjectChat={hasWorkspace}
          mode={editor.mode}
          values={editor.values}
          workspaceRoots={workspaceRoots}
          onCancel={() => {
            if (!busy) {
              setEditor(null)
              setEditorError(null)
              // Abandoning the edit abandons its conflict too.
              setVersionConflict(false)
            }
          }}
          onChange={(values) =>
            setEditor((current) => (current ? { ...current, values } : current))
          }
          onSave={() => void saveRule()}
        />
      ) : null}
      <div className="tw:grid tw:min-h-0 tw:gap-2" data-approval-rule-list={tab}>
        {loading ? (
          <p className="tw:m-0 tw:text-app-text-soft tw:type-1" role="status">
            正在加载审批规则…
          </p>
        ) : visibleRules.length ? (
          visibleRules.map((rule) => (
            <div
              className={cx(
                'tw:grid tw:min-w-0 tw:gap-1 tw:rounded-control tw:border tw:border-app-border-subtle tw:p-2',
                rule.source === 'legacy' ? 'tw:bg-app-panel' : 'tw:bg-app-canvas',
              )}
              data-approval-rule-id={rule.id}
              key={rule.id}
            >
              <div className="tw:flex tw:min-w-0 tw:items-start tw:justify-between tw:gap-3">
                <div className="tw:grid tw:min-w-0 tw:gap-1">
                  <span className="tw:text-app-text tw:type-1 tw:wrap-anywhere">
                    {approvalRuleMatchSummary(rule.match)}
                  </span>
                  <span className="tw:text-app-text-meta tw:type-1">
                    {approvalRuleScopeDescription(rule)}
                  </span>
                </div>
                <div className="tw:flex tw:shrink-0 tw:items-center tw:gap-1">
                  {canEditApprovalRule(rule) ? (
                    <Button
                      color="ghostSecondary"
                      disabled={busy}
                      size="sm"
                      onClick={() => openEdit(rule)}
                    >
                      编辑
                    </Button>
                  ) : null}
                  <Button
                    color="ghostSecondary"
                    disabled={busy}
                    size="sm"
                    onClick={() => setPendingRevoke(rule)}
                  >
                    撤销
                  </Button>
                </div>
              </div>
            </div>
          ))
        ) : (
          <p className="tw:m-0 tw:text-app-text-soft tw:type-1">
            {query.trim()
              ? '没有匹配的规则。'
              : `暂无${tab === 'ask' ? '询问' : tab === 'deny' ? '拒绝' : '允许'}规则。`}
          </p>
        )}
      </div>
      <ConfirmationDialog
        actionDisabled={busy}
        actionLabel="撤销规则"
        cancelLabel="取消"
        description={
          pendingRevoke ? (
            <>
              <p className="tw:m-0">{approvalRuleMatchSummary(pendingRevoke.match)}</p>
              <p className="tw:m-0 tw:mt-1">
                撤销后规则立即失效；旧授权撤销只影响后续判定，不会删除历史会话。
              </p>
            </>
          ) : null
        }
        open={pendingRevoke !== null}
        title="撤销审批规则？"
        tone="danger"
        onAction={() => void revokeRule()}
        onCancel={() => {
          if (!busy) setPendingRevoke(null)
        }}
      />
    </div>
  )
}
