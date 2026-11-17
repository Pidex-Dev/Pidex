import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThreadSummaryPanel } from '../src/features/session/summary/ThreadSummaryPanel.js'
import {
  THREAD_SUMMARY_COLLAPSED_SECTIONS_STORAGE_KEY,
  THREAD_SUMMARY_GUTTER_MIN_WIDTH,
  THREAD_SUMMARY_INLINE_MIN_WIDTH,
  readThreadSummaryCollapsedSections,
  readThreadSummaryOpen,
  resolveThreadSummaryDisplayMode,
  setThreadSummaryOpen,
  toggleThreadSummarySection,
} from '../src/features/session/summary/ThreadSummaryState.js'
import {
  patchConversationUiState,
  transferConversationUiStateForHandoff,
  validateConversationUiState,
} from '../src/features/layout/tabs/ConversationUiState.js'

import type { ToolItem } from '@pidex/shared/thread'

import {
  deriveThreadSummaryViewModel,
  previewThreadSummaryAgents,
  previewThreadSummarySources,
  type ThreadSummaryViewModelInput,
} from '../src/features/session/summary/ThreadSummaryViewModel.js'

describe('thread summary view model', () => {
  function buildSummaryInput(
    overrides: Partial<ThreadSummaryViewModelInput> = {},
  ): ThreadSummaryViewModelInput {
    return {
      sessionId: 'thread-1',
      workspaceName: 'Pidex',
      workspacePath: 'F:\\CodeProject\\Pidex-Ts',
      branchName: 'feature/summary',
      hasGitRepository: true,
      changedFileCount: 3,
      additions: 12,
      deletions: 4,
      goal: null,
      attachments: [],
      contextReferences: [],
      tools: [],
      sourceLinks: [],
      subagents: [],
      browserTabs: [],
      ...overrides,
    }
  }

  test('uses branch totals independently of uncommitted files and keeps unavailable totals empty', () => {
    const branchChanges = { fileCount: 42, additions: 463433, deletions: 242501 }
    const model = deriveThreadSummaryViewModel(
      buildSummaryInput({
        changedFileCount: 0,
        branchChanges,
      }),
    )
    expect(model.changes).toEqual(branchChanges)
    expect(model.environment?.changedFileCount).toBe(0)
    expect(
      deriveThreadSummaryViewModel(buildSummaryInput({ branchChanges: null })).changes,
    ).toBeNull()
    expect(
      deriveThreadSummaryViewModel(
        buildSummaryInput({
          branchChanges: { fileCount: 0, additions: 0, deletions: 0 },
        }),
      ).changes,
    ).toEqual({ fileCount: 0, additions: 0, deletions: 0 })
  })

  function toolItem(
    overrides: Partial<ToolItem> & Pick<ToolItem, 'id' | 'callID' | 'createdAt'>,
  ): ToolItem {
    return {
      type: 'tool',
      messageID: 'm1',
      turnId: 't1',
      agentId: 'a1',
      tool: 'webfetch',
      title: '',
      state: 'completed',
      command: null,
      output: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      ...overrides,
    } as ToolItem
  }

  test('derives environment, goal, agents and reports content', () => {
    const model = deriveThreadSummaryViewModel(
      buildSummaryInput({
        goal: {
          id: 'goal-1',
          threadId: 'thread-1',
          objective: '完成概览面板改造',
          status: 'active',
          tokenBudget: 100_000,
          tokensUsed: 42_000,
          timeUsedSeconds: 3665,
          version: 3,
          createdAt: 1,
          updatedAt: 2,
        },
        subagents: [
          { task: { id: 'task-1', displayName: '资料梳理' }, currentRun: { status: 'running' } },
          { task: { id: 'task-2', displayName: '回归测试' }, currentRun: { status: 'completed' } },
        ] as never,
      }),
    )

    expect(model.environment).toEqual({
      workspaceName: 'Pidex-Ts',
      workspacePath: 'F:\\CodeProject\\Pidex-Ts',
      isGitRepository: true,
      branchName: 'feature/summary',
      changedFileCount: 3,
      commitOrPushEnabled: true,
      commitOrPushDisabledReason: null,
      createPullRequestEnabled: true,
      createPullRequestDisabledReason: null,
    })
    expect(model.changes).toEqual({ fileCount: 3, additions: 12, deletions: 4 })
    expect(model.goal).toEqual({
      objective: '完成概览面板改造',
      status: 'active',
      timeUsedSeconds: 3665,
      tokenBudget: 100_000,
      tokensUsed: 42_000,
    })
    // 完成的 Agent 保留为历史行且不可停止，活动的行可停止。
    expect(model.agents).toEqual([
      {
        id: 'task-1',
        agentName: 'General Purpose',
        taskTitle: '资料梳理',
        name: '资料梳理',
        role: 'general',
        status: 'running',
        state: 'running',
        stoppable: true,
        startedAt: null,
        summary: undefined as never,
        recencyAt: undefined as never,
      },
      {
        id: 'task-2',
        agentName: 'General Purpose',
        taskTitle: '回归测试',
        name: '回归测试',
        role: 'qa',
        status: 'completed',
        state: 'finished',
        stoppable: false,
        startedAt: null,
        summary: undefined as never,
        recencyAt: undefined as never,
      },
    ])
    expect(model.hasContent).toBe(true)
  })

  test('renders expanded agents list by default and compact avatars when collapsed', () => {
    const model = deriveThreadSummaryViewModel(
      buildSummaryInput({
        subagents: [
          {
            task: { id: 'task-1', displayName: 'Inspect context.ts rules', createdAt: 10 },
            currentRun: { status: 'completed', finishedAt: 100 },
          },
          {
            task: { id: 'task-2', displayName: 'Inspect acceptance-reports structure', createdAt: 20 },
            currentRun: { status: 'completed', finishedAt: 200 },
          },
          {
            task: { id: 'task-3', displayName: 'Inventory md report dirs', createdAt: 30 },
            currentRun: { status: 'failed', finishedAt: 300 },
          },
          {
            task: {
              id: 'task-4',
              displayName: 'Explorer',
              title: 'Inventory grill-retest-round3',
              profile: 'explorer',
              role: 'general',
              createdAt: 40,
            },
            currentRun: { status: 'running', startedAt: 400 },
          },
        ] as never,
      }),
    )

    expect(model.agents.map((agent) => agent.id)).toEqual([
      'task-4',
      'task-3',
      'task-2',
      'task-1',
    ])
    expect(previewThreadSummaryAgents(model.agents)).toEqual({
      items: model.agents.slice(0, 3),
      remainingCount: 1,
      totalCount: 4,
    })

    const baseProps = {
      branches: [],
      collapsedSections: new Set<never>(),
      onToggleSection: () => {},
      onBranchSelect: async () => {},
      onCommitOrPush: () => {},
      onCreateBranch: () => {},
      onCreatePullRequest: () => {},
      onOpenReview: () => {},
      onStopSubagent: async () => {},
      onOpenWorkspacePath: () => {},
    }

    const htmlFourExpanded = renderToStaticMarkup(
      createElement(ThreadSummaryPanel, { ...baseProps, model }),
    )
    expect(htmlFourExpanded).toContain('>智能体<')
    expect(htmlFourExpanded).toContain('>1 运行<')
    expect(htmlFourExpanded).toContain('Inventory grill-retest-round3')
    expect(htmlFourExpanded).toContain('Explorer')
    expect(htmlFourExpanded).toContain('aria-label="停止 Inventory grill-retest-round3"')
    expect(htmlFourExpanded).toContain('ui-disclosure-content tw:grid tw:grid-cols-1')
    expect(htmlFourExpanded).toContain('thread-summary-section__rows tw:grid tw:grid-cols-1')
    expect(htmlFourExpanded).not.toContain('aria-label="重试')

    const htmlFourCollapsed = renderToStaticMarkup(
      createElement(ThreadSummaryPanel, {
        ...baseProps,
        collapsedSections: new Set(['agents'] as const),
        model,
      }),
    )
    const headerFourCollapsed =
      (
        htmlFourCollapsed
          .split(/<section[^>]*>/)
          .find((part) => part.includes('>智能体<')) ?? ''
      ).split('</header>')[0] ?? ''
    expect(headerFourCollapsed).toContain('>智能体<')
    expect(headerFourCollapsed).toContain('>+1<')
    expect(headerFourCollapsed.match(/<img /g)).toHaveLength(3)

    const threeModel = deriveThreadSummaryViewModel(
      buildSummaryInput({
        subagents: [
          {
            task: { id: 'task-1', displayName: 'Agent 1', createdAt: 10 },
            currentRun: { status: 'completed', finishedAt: 100 },
          },
          {
            task: { id: 'task-2', displayName: 'Agent 2', createdAt: 20 },
            currentRun: { status: 'completed', finishedAt: 200 },
          },
          {
            task: { id: 'task-3', displayName: 'Agent 3', createdAt: 30 },
            currentRun: { status: 'running', startedAt: 300 },
          },
        ] as never,
      }),
    )
    const htmlThreeCollapsed = renderToStaticMarkup(
      createElement(ThreadSummaryPanel, {
        ...baseProps,
        collapsedSections: new Set(['agents'] as const),
        model: threeModel,
      }),
    )
    const headerThreeCollapsed =
      (
        htmlThreeCollapsed
          .split(/<section[^>]*>/)
          .find((part) => part.includes('>智能体<')) ?? ''
      ).split('</header>')[0] ?? ''
    expect(headerThreeCollapsed).toContain('>智能体<')
    expect(headerThreeCollapsed).not.toContain('>+')
    expect(headerThreeCollapsed.match(/<img /g)).toHaveLength(3)
  })

  test('shows a change summary from the changed file count alone (binary files)', () => {
    const model = deriveThreadSummaryViewModel(
      buildSummaryInput({
        changedFileCount: 2,
        additions: 0,
        deletions: 0,
      }),
    )

    expect(model.changes).toEqual({ fileCount: 2, additions: 0, deletions: 0 })
    expect(model.hasContent).toBe(true)
  })

  test('hides Git rows for a workspace without a real Git repository', () => {
    const model = deriveThreadSummaryViewModel(
      buildSummaryInput({
        branchName: null,
        hasGitRepository: false,
      }),
    )

    expect(model.environment).toMatchObject({
      isGitRepository: false,
      branchName: null,
      commitOrPushEnabled: false,
      commitOrPushDisabledReason: '当前工作区不是 Git 仓库',
      createPullRequestEnabled: false,
      createPullRequestDisabledReason: '创建拉取请求前需要先创建或检出 Git 分支',
    })
  })

  test('摘要提供选择启动项和运行选中脚本，禁用的操作不可启动', () => {
    const model = deriveThreadSummaryViewModel(buildSummaryInput({ branchChanges: null }))
    const props = {
      model,
      branches: [],
      collapsedSections: new Set<never>(),
      onToggleSection: () => {},
      onBranchSelect: async () => {},
      onCommitOrPush: () => {},
      onCreateBranch: () => {},
      onCreatePullRequest: () => {},
      onOpenReview: () => {},
      onOpenWorkspacePath: () => {},
      selectedActionId: 'agent',
      workspaceActions: [
        {
          id: 'desktop',
          group: 'workspace-actions' as const,
          label: '运行桌面端',
          keywords: [],
          order: 0,
          availability: 'available' as const,
          execute: () => {},
        },
        {
          id: 'agent',
          group: 'workspace-actions' as const,
          label: '运行agent',
          keywords: [],
          order: 1,
          availability: 'available' as const,
          execute: () => {},
        },
      ],
    }
    const html = renderToStaticMarkup(createElement(ThreadSummaryPanel, props))
    const localHtml = renderToStaticMarkup(
      createElement(ThreadSummaryPanel, {
        ...props,
        model: deriveThreadSummaryViewModel(
          buildSummaryInput({ hasGitRepository: false, gitDetection: 'non-git', branchName: null }),
        ),
      }),
    )
    expect(localHtml).toContain('aria-label="运行 运行agent"')
    expect(localHtml).not.toContain('打开分支变更审查')
    expect(html).toContain('aria-label="操作"')
    expect(html).toContain('aria-label="运行 运行agent"')
    const disabled = renderToStaticMarkup(
      createElement(ThreadSummaryPanel, {
        ...props,
        workspaceActions: props.workspaceActions.map((action) => ({
          ...action,
          availability: 'disabled' as const,
        })),
      }),
    )
    expect(disabled.match(/<button[^>]*aria-label="运行 运行agent"[^>]*>/)?.[0]).toContain(
      'disabled',
    )
  })
  test('keeps review enabled without statistics and shows loading only while pending', () => {
    const model = deriveThreadSummaryViewModel(buildSummaryInput({ branchChanges: null }))
    const props = {
      model,
      branches: [],
      collapsedSections: new Set<never>(),
      onToggleSection: () => {},
      onBranchSelect: async () => {},
      onCommitOrPush: () => {},
      onCreateBranch: () => {},
      onCreatePullRequest: () => {},
      onOpenReview: () => {},
      onOpenWorkspacePath: () => {},
    }
    const html = renderToStaticMarkup(createElement(ThreadSummaryPanel, props))
    const reviewButton = html.match(/<button[^>]*title="打开分支变更审查"[^>]*>/)?.[0]
    expect(reviewButton).toBeDefined()
    expect(reviewButton).not.toContain('disabled')
    expect(html).not.toContain('暂不可用')
    expect(html).not.toContain('正在加载变更统计')
    expect(
      renderToStaticMarkup(
        createElement(ThreadSummaryPanel, {
          ...props,
          changesLoading: true,
        }),
      ),
    ).toContain('正在加载变更统计')
  })

  test('shows output empty state only for confirmed non-Git, preserving sources during detection', () => {
    for (const gitDetection of ['loading', 'error', 'non-git', 'git'] as const) {
      const model = deriveThreadSummaryViewModel(
        buildSummaryInput({
          gitDetection,
          hasGitRepository: gitDetection === 'git',
          branchChanges: null,
          sourceLinks: [{ label: '资料', url: 'https://example.com' }],
        }),
      )
      const html = renderToStaticMarkup(
        createElement(ThreadSummaryPanel, {
          model,
          branches: [],
          collapsedSections: new Set<never>(),
          onToggleSection: () => {},
          onBranchSelect: async () => {},
          onCommitOrPush: () => {},
          onCreateBranch: () => {},
          onCreatePullRequest: () => {},
          onOpenReview: () => {},
          onOpenWorkspacePath: () => {},
          onRetryGitDetection: () => {},
        }),
      )
      expect(html.includes('创建文件或站点')).toBe(gitDetection === 'non-git')
      expect(html).not.toContain('正在检测仓库')
      expect(html.includes('仓库检测失败')).toBe(gitDetection === 'error')
      expect(html).toContain('资料')
    }
  })

  test('uses the repository root name when the workspace is a subdirectory', () => {
    const model = deriveThreadSummaryViewModel(
      buildSummaryInput({
        workspaceName: '自定义项目名',
        workspacePath: 'F:\\CodeProject\\Pidex\\apps\\desktop',
        repositoryRoot: 'F:\\CodeProject\\Pidex',
      }),
    )
    expect(model.environment?.workspaceName).toBe('Pidex')
  })

  test('dedupes sources by identity and excludes drafts by construction', () => {
    const model = deriveThreadSummaryViewModel(
      buildSummaryInput({
        attachments: [
          {
            id: 'att-1',
            kind: 'image',
            name: '截图.png',
            mediaType: 'image/png',
            sizeBytes: 10,
            sha256: 'sha',
            createdAt: 1,
          },
          // 同一附件重复提交只保留一条。
          {
            id: 'att-1',
            kind: 'image',
            name: '截图.png',
            mediaType: 'image/png',
            sizeBytes: 10,
            sha256: 'sha',
            createdAt: 1,
          },
        ],
        contextReferences: [
          {
            id: 'ref-1',
            name: 'docs',
            path: 'docs',
            kind: 'directory',
            status: 'available',
          },
        ],
        tools: [
          toolItem({
            id: 'tool-1',
            callID: 'call-1',
            createdAt: 2,
            activity: { type: 'web_search' },
            resultBlocks: [{ type: 'citation', title: '示例站', url: 'https://a.dev/' }],
          }),
          toolItem({
            id: 'tool-2',
            callID: 'call-2',
            createdAt: 3,
            activity: { type: 'integration', source: 'github-mcp' },
          }),
          // 重复的网页搜索与同名集成来源都会被身份去重合并。
          toolItem({
            id: 'tool-3',
            callID: 'call-3',
            createdAt: 4,
            activity: { type: 'web_search' },
          }),
        ],
        sourceLinks: [{ label: '重复链接', url: 'https://a.dev/' }],
      }),
    )

    // 顺序：附件 → 引用 → citation/链接（按 URL 合并）→ 工具来源。
    expect(
      model.sources.map((source) => ({
        kind: source.kind,
        identity: source.identity,
        label: source.label,
      })),
    ).toEqual([
      { kind: 'attachment', identity: 'attachment:att-1', label: '截图.png' },
      { kind: 'reference', identity: 'reference:ref-1', label: 'docs' },
      { kind: 'link', identity: 'link:https://a.dev/', label: '示例站' },
      { kind: 'tool', identity: 'tool:web-search', label: '网页搜索' },
      { kind: 'tool', identity: 'tool:integration:github-mcp', label: 'github-mcp' },
    ])
    // citation 与正文链接身份相同则合并；网页来源 URL 携带 citation 的链接。
    expect(
      model.sources.some((source) => source.kind === 'link' && source.url === 'https://a.dev/'),
    ).toBe(true)
    expect(model.hasContent).toBe(true)
  })

  test('dedupes artifacts by id with the most recent declaration winning', () => {
    const model = deriveThreadSummaryViewModel(
      buildSummaryInput({
        tools: [
          toolItem({
            id: 'tool-1',
            callID: 'call-1',
            createdAt: 1,
            resultBlocks: [
              { type: 'artifact', artifactId: 'art-1', name: '旧版本', mimeType: 'text/markdown' },
            ],
          }),
          toolItem({
            id: 'tool-2',
            callID: 'call-2',
            createdAt: 2,
            resultBlocks: [
              {
                type: 'artifact',
                artifactId: 'art-1',
                name: '新版本',
                mimeType: 'text/markdown',
                size: 24,
              },
              {
                type: 'artifact',
                artifactId: 'art-2',
                name: '截图',
                mimeType: 'image/png',
                size: 512,
              },
              {
                type: 'artifact',
                artifactId: 'art-3',
                name: '数据集',
                mimeType: 'application/octet-stream',
              },
            ],
          }),
        ],
      }),
    )

    expect(model.artifacts).toEqual([
      {
        artifactId: 'art-1',
        name: '新版本',
        mimeType: 'text/markdown',
        sizeBytes: 24,
        previewKind: 'text',
      },
      {
        artifactId: 'art-2',
        name: '截图',
        mimeType: 'image/png',
        sizeBytes: 512,
        previewKind: 'image',
      },
      {
        artifactId: 'art-3',
        name: '数据集',
        mimeType: 'application/octet-stream',
        sizeBytes: null,
        previewKind: 'binary',
      },
    ])
  })

  test('keeps browser tabs of the source and controlling chat only and drops closed tabs', () => {
    const model = deriveThreadSummaryViewModel(
      buildSummaryInput({
        browserTabs: [
          {
            tabId: 'tab-2',
            open: true,
            sourceThreadId: 'thread-2',
            controlThreadId: 'thread-1',
            title: '文档',
            url: 'https://b.dev/page',
            order: 1,
          },
          {
            tabId: 'tab-1',
            open: true,
            sourceThreadId: 'thread-1',
            title: '',
            url: 'https://a.dev/x',
            loading: true,
            panel: 'bottom',
            order: 2,
          },
          {
            tabId: 'tab-3',
            open: true,
            sourceThreadId: 'thread-2',
            title: '无关标签',
            url: 'https://c.dev/',
            order: 0,
          },
          {
            tabId: 'tab-4',
            open: false,
            sourceThreadId: 'thread-1',
            title: '已关闭',
            url: 'https://d.dev/',
          },
          {
            tabId: 'tab-1',
            open: true,
            sourceThreadId: 'thread-1',
            title: '',
            url: 'https://a.dev/x',
            order: 2,
          },
        ] as unknown as ThreadSummaryViewModelInput['browserTabs'],
      }),
    )

    expect(model.browserTabs).toEqual([
      { tabId: 'tab-2', title: '文档', domain: 'b.dev', state: 'idle', panel: 'right' },
      { tabId: 'tab-1', title: 'a.dev', domain: 'a.dev', state: 'loading', panel: 'bottom' },
    ])
  })

  test('keeps the output empty state available without a repository', () => {
    const model = deriveThreadSummaryViewModel(
      buildSummaryInput({
        workspaceName: null,
        workspacePath: null,
        branchName: null,
        hasGitRepository: false,
        changedFileCount: 0,
        additions: 0,
        deletions: 0,
      }),
    )

    expect(model.hasContent).toBe(true)
    expect(model.environment).toBeNull()
    expect(model.changes).toBeNull()
    expect(model.goal).toBeNull()
    expect(model.agents).toEqual([])
    expect(model.browserTabs).toEqual([])
    expect(model.sources).toEqual([])
    expect(model.artifacts).toEqual([])
  })

  test('previews the first three sources for the summary side panel', () => {
    const sources: Parameters<typeof previewThreadSummarySources>[0] = Array.from(
      { length: 7 },
      (_, index) => ({
        kind: 'link' as const,
        identity: `link:https://example.com/${index + 1}`,
        label: `来源 ${index + 1}`,
        url: `https://example.com/${index + 1}`,
      }),
    )

    expect(previewThreadSummarySources(sources)).toEqual({
      items: sources.slice(0, 3),
      totalCount: 7,
    })
  })
})

function withMockLocalStorage(run: (storage: Storage) => void): void {
  const map = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return map.size
    },
    clear() {
      map.clear()
    },
    getItem(key) {
      return map.get(key) ?? null
    },
    key(index) {
      return Array.from(map.keys())[index] ?? null
    },
    removeItem(key) {
      map.delete(key)
    },
    setItem(key, value) {
      map.set(key, String(value))
    },
  }
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage },
  })
  try {
    run(storage)
  } finally {
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', originalWindowDescriptor)
    } else {
      Reflect.deleteProperty(globalThis, 'window')
    }
  }
}

describe('thread summary persistence and placement', () => {
  test('resolves overlay, shift, and gutter display modes from container width', () => {
    expect(resolveThreadSummaryDisplayMode(0)).toBe('overlay')
    expect(resolveThreadSummaryDisplayMode(THREAD_SUMMARY_INLINE_MIN_WIDTH - 1)).toBe('overlay')
    expect(resolveThreadSummaryDisplayMode(THREAD_SUMMARY_INLINE_MIN_WIDTH)).toBe('shift')
    expect(resolveThreadSummaryDisplayMode(THREAD_SUMMARY_GUTTER_MIN_WIDTH - 1)).toBe('shift')
    expect(resolveThreadSummaryDisplayMode(THREAD_SUMMARY_GUTTER_MIN_WIDTH)).toBe('gutter')
  })

  test('persists per-conversation open state across reloads, patches, and handoff', () => {
    withMockLocalStorage((storage) => {
      expect(readThreadSummaryOpen('thread-a')).toBe(false)
      expect(readThreadSummaryOpen('thread-b')).toBe(false)

      setThreadSummaryOpen('thread-a', true)
      expect(readThreadSummaryOpen('thread-a')).toBe(true)
      expect(readThreadSummaryOpen('thread-b')).toBe(false)

      patchConversationUiState('thread-a', { mainScrollTop: 120 })
      expect(readThreadSummaryOpen('thread-a')).toBe(true)

      const transferResult = transferConversationUiStateForHandoff({
        sourceThreadId: 'thread-a',
        targetThreadId: 'thread-a-worktree',
        sourceWorkspacePath: 'F:\\CodeProject\\Pidex-Ts',
      })
      expect(transferResult.transferred).toBe(true)
      expect(readThreadSummaryOpen('thread-a-worktree')).toBe(true)

      setThreadSummaryOpen('thread-a', false)
      expect(readThreadSummaryOpen('thread-a')).toBe(false)

      setThreadSummaryOpen(null, true)
      expect(readThreadSummaryOpen(null)).toBe(true)
      expect(storage.getItem('conversation.ui-state.null')).toBeNull()
      setThreadSummaryOpen(null, false)
    })
  })

  test('defaults summaryOpen to false when validating legacy conversation UI state', () => {
    expect(validateConversationUiState({ schemaVersion: 4, mainScrollTop: 10 }).summaryOpen).toBe(
      false,
    )
    expect(
      validateConversationUiState({ schemaVersion: 4, summaryOpen: true }).summaryOpen,
    ).toBe(true)
  })

  test('persists collapsed sections globally and ignores invalid entries', () => {
    withMockLocalStorage((storage) => {
      expect([...readThreadSummaryCollapsedSections()]).toEqual([])

      toggleThreadSummarySection('sources')
      toggleThreadSummarySection('environment')
      expect([...readThreadSummaryCollapsedSections()]).toEqual(['environment', 'sources'])

      toggleThreadSummarySection('environment')
      expect([...readThreadSummaryCollapsedSections()]).toEqual(['sources'])

      storage.setItem(
        THREAD_SUMMARY_COLLAPSED_SECTIONS_STORAGE_KEY,
        JSON.stringify(['goal', 'unknown-section', 42]),
      )
      expect([...readThreadSummaryCollapsedSections()]).toEqual(['goal'])
    })
  })
})
