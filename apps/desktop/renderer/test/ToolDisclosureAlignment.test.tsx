import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Item } from '@pidex/shared/thread'
import type { RenderTurnEntry } from '@pidex/session-view'

import { TooltipProvider } from '../src/components/ui/Tooltip.js'
import { createKeyedDisclosureStore } from '../src/components/ui/KeyedDisclosureStore.js'
import {
  buildToolItemDisplay,
  ToolExecutionCard,
  ToolItemView,
} from '../src/features/session/timeline/CanonicalItemRenderer.js'
import {
  CanonicalConversationTurn,
  CanonicalTurnActivity,
} from '../src/features/session/timeline/CanonicalThreadView.js'
import {
  ConversationItemContext,
  type ConversationItemContextValue,
} from '../src/features/session/timeline/ConversationItemContext.js'
import { groupRepeatedProcessItems } from '../src/features/session/timeline/GroupRepeatedProcessItems.js'
import { preserveTimelineAnchorPosition } from '../src/features/session/timeline/PreserveTimelineAnchorPosition.js'
import {
  processGroupDisclosureId,
  processGroupUnitKey,
} from '../src/features/session/timeline/TimelineDisclosureState.js'

type ToolItem = Extract<Item, { type: 'tool' }>

const CONTEXT_VALUE: ConversationItemContextValue = {
  canCopyFileReferenceContents: () => false,
  onCopyFileReferenceContents: () => undefined,
  onOpenFileReference: () => undefined,
  onSubmitEditedUserMessage: async () => undefined,
  sessionStatus: 'idle',
  workspacePath: 'C:/workspace',
}

function makeTool(overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    id: 'tool-1',
    messageID: 'msg-1',
    turnId: 'turn-1',
    agentId: 'agent-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'BrowserAction',
    title: 'BrowserAction',
    state: 'completed',
    input: { action: 'click', ref: 'e1' },
    command: null,
    activity: { type: 'tool', mode: 'call', name: 'BrowserAction' },
    output: 'ok',
    error: null,
    startedAt: 1_000,
    finishedAt: 1_100,
    durationMs: 100,
    createdAt: 1_000,
    ...overrides,
  }
}

function makeTurnEntry(processItems: Item[]): RenderTurnEntry {
  return {
    id: 'turn-1',
    turn: {
      id: 'turn-1',
      threadId: 'thread-1',
      status: 'completed',
      model: null,
      startedAt: 1_000,
      finishedAt: 2_500,
      elapsedSeconds: 2,
      error: null,
      createdAt: 1_000,
      updatedAt: 2_500,
    },
    items: processItems,
    userInputs: [],
    userItems: [],
    inlineInputs: [],
    attachments: [],
    contextReferences: [],
    processItems,
    assistantResultItems: [],
    contentBlocks: [],
    patchItems: [],
    postAssistantItems: [],
    planItem: null,
    blockers: [],
    approvals: [],
    decisionNotices: [],
    forceExpandActivity: true,
  }
}

describe('Codex-aligned tool disclosure behavior', () => {
  test('only allows failed or interrupted read/search/list_files exploration tools to expand', () => {
    const explorationActivities = [
      { type: 'read', subject: 'file', target: { displayLabel: 'src/a.ts' } },
      { type: 'search', query: 'needle' },
      { type: 'list_files', path: { displayLabel: 'src' } },
    ] as const

    for (const activity of explorationActivities) {
      const completed = makeTool({ activity, output: 'some content', state: 'completed' })
      const running = makeTool({ activity, output: null, state: 'running' })
      const failedWithOutput = makeTool({
        activity,
        output: null,
        error: '权限不足',
        state: 'error',
      })
      const failedEmpty = makeTool({ activity, output: null, error: null, state: 'error' })

      expect(buildToolItemDisplay(completed).canExpand).toBe(false)
      expect(buildToolItemDisplay(running).canExpand).toBe(false)
      expect(buildToolItemDisplay(failedWithOutput).canExpand).toBe(true)
      expect(buildToolItemDisplay(failedEmpty).canExpand).toBe(false)
    }
  })

  test('allows running generic tools to expand immediately and omits empty fallback inputs', () => {
    const runningWithInput = makeTool({ state: 'running', output: null })
    const displayWithInput = buildToolItemDisplay(runningWithInput)
    expect(displayWithInput.canExpand).toBe(true)
    expect(displayWithInput.hasExplicitInput).toBe(true)

    const emptyInputTool = makeTool({
      input: {},
      output: 'done',
      state: 'completed',
    })
    const emptyInputDisplay = buildToolItemDisplay(emptyInputTool)
    expect(emptyInputDisplay.hasExplicitInput).toBe(false)
    expect(emptyInputDisplay.canExpand).toBe(true)

    const cardMarkup = renderToStaticMarkup(
      <TooltipProvider>
        <ToolExecutionCard item={emptyInputTool} view={emptyInputDisplay} />
      </TooltipProvider>,
    )
    expect(cardMarkup).not.toContain('canonical-command-card__section-label">输入</div>')
    expect(cardMarkup).toContain('canonical-command-card__section-label">输出</div>')
    expect(cardMarkup).toContain('done')
    expect(cardMarkup).toContain('tw:justify-end')
  })

  test('collapses consecutive identical generic/MCP/integration tools inside a process group without folding commands or file mutations', () => {
    const items: Item[] = [
      makeTool({ id: 't1', callID: 'c1', createdAt: 1 }),
      makeTool({ id: 't2', callID: 'c2', createdAt: 2, state: 'running', output: null }),
      makeTool({ id: 't3', callID: 'c3', createdAt: 3 }),
      makeTool({
        id: 'cmd1',
        callID: 'c4',
        tool: 'Bash',
        command: 'git status',
        activity: { type: 'command', kind: 'generic' },
        createdAt: 4,
      }),
      makeTool({
        id: 'cmd2',
        callID: 'c5',
        tool: 'Bash',
        command: 'bun test',
        activity: { type: 'command', kind: 'test' },
        createdAt: 5,
      }),
      makeTool({
        id: 'edit1',
        callID: 'c6',
        tool: 'Edit',
        input: { file_path: 'src/a.ts' },
        activity: { type: 'file_change', changes: [{ path: 'src/a.ts', operation: 'update' }] },
        createdAt: 6,
      }),
      makeTool({
        id: 'edit2',
        callID: 'c7',
        tool: 'Edit',
        input: { file_path: 'src/b.ts' },
        activity: { type: 'file_change', changes: [{ path: 'src/b.ts', operation: 'update' }] },
        createdAt: 7,
      }),
      makeTool({
        id: 'mcp1',
        callID: 'c8',
        tool: 'mcp__github__search',
        activity: { type: 'integration', source: 'github' },
        createdAt: 8,
      }),
      makeTool({
        id: 'mcp2',
        callID: 'c9',
        tool: 'mcp__github__search',
        activity: { type: 'integration', source: 'github' },
        state: 'error',
        error: 'rate limit',
        createdAt: 9,
      }),
      makeTool({
        id: 'single1',
        callID: 'c10',
        tool: 'BrowserSnapshot',
        activity: { type: 'tool', mode: 'call', name: 'BrowserSnapshot' },
        createdAt: 10,
      }),
    ]

    const runs = groupRepeatedProcessItems(items)
    expect(runs).toHaveLength(7)
    expect(runs[0]).toMatchObject({
      kind: 'repeated',
      label: '调用工具 BrowserAction · 3 次调用',
      active: true,
      failed: false,
    })
    expect(runs[1]).toMatchObject({ kind: 'single', item: { id: 'cmd1' } })
    expect(runs[2]).toMatchObject({ kind: 'single', item: { id: 'cmd2' } })
    expect(runs[3]).toMatchObject({ kind: 'single', item: { id: 'edit1' } })
    expect(runs[4]).toMatchObject({ kind: 'single', item: { id: 'edit2' } })
    expect(runs[5]).toMatchObject({
      kind: 'repeated',
      label: '使用 github · 2 次调用',
      active: false,
      failed: true,
    })
    expect(runs[6]).toMatchObject({ kind: 'single', item: { id: 'single1' } })
  })

  test('renders repeated tool sub-disclosures inside expanded process groups and slide variant on turn activity', () => {
    const items = [
      makeTool({ id: 'b1', callID: 'cb1', createdAt: 1 }),
      makeTool({ id: 'b2', callID: 'cb2', createdAt: 2 }),
    ]
    const unitKey = processGroupUnitKey('b1')
    const groupDisclosureId = processGroupDisclosureId('turn-1', unitKey)
    const repeatedDisclosureId = processGroupDisclosureId(
      'turn-1',
      `${unitKey}:repeated:b1:tool:call:browseraction`,
    )

    const collapsedStore = createKeyedDisclosureStore({
      initialExpandedKeys: [groupDisclosureId],
    })
    const expandedStore = createKeyedDisclosureStore({
      initialExpandedKeys: [groupDisclosureId, repeatedDisclosureId],
    })

    const renderTurn = (store: ReturnType<typeof createKeyedDisclosureStore>) =>
      renderToStaticMarkup(
        <TooltipProvider>
          <ConversationItemContext.Provider value={CONTEXT_VALUE}>
            <CanonicalConversationTurn
              disclosureState={store}
              dockedPlanItemId={null}
              entry={makeTurnEntry(items)}
              onOpenPlanInRightDock={() => undefined}
              onOpenSubagent={() => undefined}
            />
          </ConversationItemContext.Provider>
        </TooltipProvider>,
      )

    const collapsedSubgroupHtml = renderTurn(collapsedStore)
    expect(collapsedSubgroupHtml).toContain('调用工具 BrowserAction · 2 次调用')
    expect(collapsedSubgroupHtml).toContain('cpx-agent-activity__repeated-group')
    expect(collapsedSubgroupHtml).not.toContain('已调用工具 BrowserAction')

    const expandedSubgroupHtml = renderTurn(expandedStore)
    expect(expandedSubgroupHtml).toContain('调用工具 BrowserAction · 2 次调用')
    expect(
      expandedSubgroupHtml.match(/class="cpx-agent-activity__verb">已调用工具<\/span>/g),
    ).toHaveLength(2)

    const turnActivityMarkup = renderToStaticMarkup(
      <CanonicalTurnActivity
        canCollapse
        expanded
        onExpandedChange={() => undefined}
        summary={{ kind: 'worked', label: '已处理 2s' }}
      >
        <div>body</div>
      </CanonicalTurnActivity>,
    )
    expect(turnActivityMarkup).toContain('data-variant="slide"')
  })

  test('renders non-expandable completed exploration rows without disclosure chevron', () => {
    const readTool = makeTool({
      tool: 'Read',
      activity: { type: 'read', subject: 'file', target: { displayLabel: 'README.md' } },
      output: '# Readme',
    })
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ToolItemView item={readTool} />
      </TooltipProvider>,
    )
    expect(html).toContain('data-expandable="false"')
    expect(html).not.toContain('lucide-chevron-right')
  })

  test('preserveTimelineAnchorPosition safely no-ops without DOM and compensates scrollTop when anchor shifts', () => {
    expect(() => preserveTimelineAnchorPosition(null)).not.toThrow()

    let currentTop = 100
    let scheduledFrame: FrameRequestCallback | null = null
    const listeners = new Map<string, () => void>()
    const scroller = {
      scrollTop: 50,
      addEventListener: (name: string, fn: () => void) => {
        listeners.set(name, fn)
      },
    }
    const anchor = {
      isConnected: true,
      parentElement: null,
      closest: (selector: string) =>
        selector.includes('thread-scroll-layout') ? (scroller as unknown as HTMLElement) : null,
      getBoundingClientRect: () => ({ top: currentTop }) as DOMRect,
    } as unknown as HTMLElement

    const prevWindow = globalThis.window
    const timers: ReturnType<typeof setTimeout>[] = []
    globalThis.window = {
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        scheduledFrame = cb
        return 1
      },
      cancelAnimationFrame: () => undefined,
      setTimeout: (cb: () => void, ms: number) => {
        const id = setTimeout(cb, ms)
        timers.push(id)
        return id
      },
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      getComputedStyle: () => ({ overflowY: 'visible' }),
    } as unknown as Window & typeof globalThis

    try {
      const dispose = preserveTimelineAnchorPosition(anchor, 350)
      currentTop = 140
      scheduledFrame?.(16)
      expect(scroller.scrollTop).toBe(90)

      listeners.get('wheel')?.()
      currentTop = 200
      scheduledFrame?.(32)
      expect(scroller.scrollTop).toBe(90)
      dispose()
    } finally {
      for (const id of timers) clearTimeout(id)
      globalThis.window = prevWindow
    }
  })
})
