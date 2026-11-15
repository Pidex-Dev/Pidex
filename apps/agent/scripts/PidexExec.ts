import { Capabilities, decodeEventEnvelope } from '@pidex/agent-protocol'
import {
  AUTO_REVIEW_PERMISSION_CONFIG,
  DEFAULT_PERMISSION_CONFIG,
  FULL_ACCESS_PERMISSION_CONFIG,
  type PermissionConfig,
} from '@pidex/shared/thread'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

type TaskMode = 'chat' | 'plan' | 'grill'
type PermissionPresetName = 'full-access' | 'auto-review' | 'default'

interface CliArgs {
  help: boolean
  listModels: boolean
  json: boolean
  cwd: string
  prompt?: string
  provider?: string
  model?: string
  mode: TaskMode
  permission: PermissionPresetName
  worktree: boolean
  threadId?: string
  deleteThread: boolean
  dataDir?: string
  url?: string
  token?: string
  timeoutMs: number
}

interface RpcTransport {
  request(url: string, init?: RequestInit): Response | Promise<Response>
  dispose(): Promise<void>
}

interface ModelCatalogEntry {
  provider: { id: string; name?: string; disabled?: boolean }
  models: Array<{
    id: string
    providerID: string
    name: string
    enabled: boolean
    modelType?: string
  }>
}

interface ModelCatalogResponse {
  providers: ModelCatalogEntry[]
  defaultModel: { providerID: string; id: string; variant?: string } | null
}

interface TurnUsageSummary {
  provider?: string
  model?: string
  steps: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  lastStep: Record<string, unknown>
}

const finiteNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

const accumulateUsage = (
  current: TurnUsageSummary | undefined,
  stepUsage: Record<string, unknown>,
): TurnUsageSummary => ({
  ...(typeof stepUsage.provider === 'string'
    ? { provider: stepUsage.provider }
    : current?.provider
      ? { provider: current.provider }
      : {}),
  ...(typeof stepUsage.model === 'string'
    ? { model: stepUsage.model }
    : current?.model
      ? { model: current.model }
      : {}),
  steps: (current?.steps ?? 0) + 1,
  input: (current?.input ?? 0) + finiteNumber(stepUsage.input),
  output: (current?.output ?? 0) + finiteNumber(stepUsage.output),
  cacheRead: (current?.cacheRead ?? 0) + finiteNumber(stepUsage.cacheRead),
  cacheWrite: (current?.cacheWrite ?? 0) + finiteNumber(stepUsage.cacheWrite),
  reasoning: (current?.reasoning ?? 0) + finiteNumber(stepUsage.reasoning),
  lastStep: stepUsage,
})

const HELP_TEXT = `Pidex Headless CLI Runner (thread-rpc-v4)

Usage:
  bun apps/agent/scripts/PidexExec.ts [options] [prompt]

Options:
  -p, --prompt <text>         Prompt text (or "-" to read from stdin)
  -C, --cwd <dir>             Workspace directory (default: current directory)
  -m, --model <id>            Model id (or "<providerID>/<modelID>")
      --provider <id>         Provider id (optional if --model uses provider/id)
      --mode <mode>           Task mode: chat | plan | grill (default: chat)
      --permission <preset>   Permission preset: full-access | auto-review | default (default: full-access)
      --worktree              Use managed Git worktree instead of local execution
      --thread <id>           Continue an existing thread id
      --delete-thread         Delete newly created thread after completion
      --data-dir <dir>        Override PIDEX_DATA_DIR (default: ~/.pidex)
      --url <origin>          Attach to a running Agent HTTP server (e.g. http://127.0.0.1:4321)
      --token <token>         Bearer auth token when using --url
      --timeout-ms <ms>       Turn timeout in milliseconds (default: 600000)
      --json, --jsonl         Emit normalized NDJSON events + final result to stdout
      --list-models           List enabled chat models from Pidex config and exit
  -h, --help                  Show this help message
`

const PERMISSION_PRESETS: Record<PermissionPresetName, PermissionConfig> = {
  'full-access': FULL_ACCESS_PERMISSION_CONFIG,
  'auto-review': AUTO_REVIEW_PERMISSION_CONFIG,
  default: DEFAULT_PERMISSION_CONFIG,
}

const STRICT_DELTA_EVENTS = new Set([
  'item/agentMessage/delta',
  'plan/delta',
  'reasoning/textDelta',
  'tool/outputDelta',
  'context/compacted',
])

const BLOCKING_INTERACTION_EVENTS = new Set([
  'approval/requested',
  'permission/requested',
  'question/requested',
  'hookTrust/requested',
  'mcp/elicitationRequested',
])

function parseCliArgs(argv: readonly string[]): CliArgs {
  const result: CliArgs = {
    help: false,
    listModels: false,
    json: false,
    cwd: process.cwd(),
    mode: 'chat',
    permission: 'full-access',
    worktree: false,
    deleteThread: false,
    timeoutMs: 600_000,
  }
  const positionals: string[] = []

  const takeValue = (flag: string, index: number): string => {
    const value = argv[index + 1]
    if (value === undefined) {
      throw new Error(`Missing value for ${flag}`)
    }
    return value
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '-h' || arg === '--help') {
      result.help = true
    } else if (arg === '--list-models') {
      result.listModels = true
    } else if (arg === '--json' || arg === '--jsonl') {
      result.json = true
    } else if (arg === '--worktree') {
      result.worktree = true
    } else if (arg === '--delete-thread') {
      result.deleteThread = true
    } else if (arg === '-p' || arg === '--prompt') {
      result.prompt = takeValue(arg, i)
      i += 1
    } else if (arg === '-C' || arg === '--cwd') {
      result.cwd = takeValue(arg, i)
      i += 1
    } else if (arg === '-m' || arg === '--model') {
      result.model = takeValue(arg, i)
      i += 1
    } else if (arg === '--provider') {
      result.provider = takeValue(arg, i)
      i += 1
    } else if (arg === '--mode') {
      const mode = takeValue(arg, i)
      if (mode !== 'chat' && mode !== 'plan' && mode !== 'grill') {
        throw new Error(`Invalid --mode "${mode}". Expected chat | plan | grill.`)
      }
      result.mode = mode
      i += 1
    } else if (arg === '--permission') {
      const preset = takeValue(arg, i)
      if (preset !== 'full-access' && preset !== 'auto-review' && preset !== 'default') {
        throw new Error(
          `Invalid --permission "${preset}". Expected full-access | auto-review | default.`,
        )
      }
      result.permission = preset
      i += 1
    } else if (arg === '--thread') {
      result.threadId = takeValue(arg, i)
      i += 1
    } else if (arg === '--data-dir') {
      result.dataDir = takeValue(arg, i)
      i += 1
    } else if (arg === '--url') {
      result.url = takeValue(arg, i)
      i += 1
    } else if (arg === '--token') {
      result.token = takeValue(arg, i)
      i += 1
    } else if (arg === '--timeout-ms') {
      const parsed = Number(takeValue(arg, i))
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('Invalid --timeout-ms value.')
      }
      result.timeoutMs = Math.trunc(parsed)
      i += 1
    } else if (arg === '-') {
      positionals.push(arg)
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    } else {
      positionals.push(arg)
    }
  }

  if (result.prompt === undefined && positionals.length > 0) {
    result.prompt = positionals.join(' ')
  }

  return result
}

async function resolvePromptText(rawPrompt: string | undefined): Promise<string> {
  if (rawPrompt === '-') {
    return (await Bun.stdin.text()).trim()
  }
  if (rawPrompt !== undefined) {
    return rawPrompt
  }
  if (!process.stdin.isTTY) {
    const piped = (await Bun.stdin.text()).trim()
    if (piped) return piped
  }
  return ''
}

async function createTransport(args: CliArgs): Promise<RpcTransport> {
  if (args.url) {
    const origin = args.url.replace(/\/+$/, '')
    return {
      request(pathOrUrl: string, init?: RequestInit) {
        const target = pathOrUrl.startsWith('http://agent.local')
          ? `${origin}${pathOrUrl.slice('http://agent.local'.length)}`
          : pathOrUrl
        const headers = new Headers(init?.headers)
        if (args.token) {
          headers.set('authorization', `Bearer ${args.token}`)
        }
        return fetch(target, { ...init, headers })
      },
      async dispose() {},
    }
  }

  if (args.dataDir) {
    process.env.PIDEX_DATA_DIR = resolve(args.dataDir)
  }

  const { Effect } = await import('effect')
  const { createBootstrap } = await import('../src/Bootstrap')
  const runtime = await Effect.runPromise(createBootstrap())
  return {
    request(pathOrUrl: string, init?: RequestInit) {
      return runtime.app.request(pathOrUrl, init)
    },
    async dispose() {
      await runtime.dispose()
      runtime.db.close()
    },
  }
}

function createRpcClient(transport: RpcTransport) {
  let seq = 0
  let connectionId = ''

  const call = async <T = any>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> => {
    const response = await transport.request('http://agent.local/rpc', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(connectionId ? { 'x-pidex-connection-id': connectionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `cli:${++seq}`,
        method,
        params,
      }),
    })
    const payload = (await response.json()) as { result?: T; error?: unknown }
    if (payload.error) {
      throw new Error(`RPC ${method} failed: ${JSON.stringify(payload.error)}`)
    }
    return payload.result as T
  }

  const initialize = async () => {
    const init = await call<{ connectionId: string }>('initialize', {
      clientInfo: {
        name: 'pidex-exec-cli',
        version: '0.1.0',
        platform: process.platform,
      },
      protocols: ['thread-rpc-v4'],
      capabilities: [...Capabilities],
      interactionDelivery: 'active',
    })
    connectionId = init.connectionId
    await transport.request('http://agent.local/rpc', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pidex-connection-id': connectionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialized',
        params: { protocol: 'thread-rpc-v4' },
      }),
    })
    return connectionId
  }

  return {
    call,
    initialize,
    getConnectionId: () => connectionId,
  }
}

function selectModel(
  catalog: ModelCatalogResponse,
  requestedProvider?: string,
  requestedModel?: string,
): { providerID: string; id: string; variant?: string } {
  const allChatModels = catalog.providers.flatMap((entry) =>
    entry.models.filter((m) => m.enabled && (!m.modelType || m.modelType === 'chat')),
  )

  if (requestedModel) {
    const directMatch = allChatModels.find(
      (m) =>
        m.id === requestedModel &&
        (!requestedProvider || String(m.providerID) === requestedProvider),
    )
    if (directMatch) {
      return { providerID: String(directMatch.providerID), id: String(directMatch.id) }
    }

    if (!requestedProvider && requestedModel.includes('/')) {
      const slash = requestedModel.indexOf('/')
      const prefix = requestedModel.slice(0, slash)
      const rest = requestedModel.slice(slash + 1)
      const prefixedMatch = allChatModels.find(
        (m) => String(m.providerID) === prefix && m.id === rest,
      )
      if (prefixedMatch) {
        return { providerID: String(prefixedMatch.providerID), id: String(prefixedMatch.id) }
      }
      return { providerID: prefix, id: rest }
    }

    if (requestedProvider) {
      return { providerID: requestedProvider, id: requestedModel }
    }
    throw new Error(
      `Model "${requestedModel}" not found among enabled chat models. Run with --list-models to inspect.`,
    )
  }

  if (catalog.defaultModel) {
    return catalog.defaultModel
  }

  const first = allChatModels[0]
  if (!first) {
    throw new Error(
      'No enabled chat models found in Pidex config. Configure a provider/model in Pidex first.',
    )
  }
  return { providerID: String(first.providerID), id: String(first.id) }
}

async function resolveOrCreateProject(
  call: <T = any>(method: string, params?: Record<string, unknown>) => Promise<T>,
  cwd: string,
): Promise<string> {
  const canonicalCwd = await realpath(resolve(cwd))
  const existing = await call<{ projects: Array<{ id: string }> }>('project/list', {
    folderPath: canonicalCwd,
    limit: 1,
  })
  if (existing.projects[0]) {
    return existing.projects[0].id
  }
  const created = await call<{ project: { id: string } }>('project/create', {
    primaryPath: canonicalCwd,
    operationId: crypto.randomUUID(),
  })
  return created.project.id
}

function emitJsonLine(enabled: boolean, payload: Record<string, unknown>): void {
  if (!enabled) return
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP_TEXT)
    return 0
  }

  const prompt = args.listModels ? '' : await resolvePromptText(args.prompt)
  if (!args.listModels && !prompt.trim()) {
    process.stderr.write('Error: prompt is required. Pass --prompt "..." or positional text.\n')
    process.stderr.write(HELP_TEXT)
    return 1
  }

  const transport = await createTransport(args)
  let createdThreadId: string | undefined
  let subscriptionId: string | undefined
  const rpc = createRpcClient(transport)

  try {
    const connectionId = await rpc.initialize()
    const catalog = await rpc.call<ModelCatalogResponse>('model/list', { enabled: true })

    if (args.listModels) {
      const models = catalog.providers.flatMap((entry) =>
        entry.models
          .filter((m) => m.enabled && (!m.modelType || m.modelType === 'chat'))
          .map((m) => ({
            providerID: String(m.providerID),
            id: String(m.id),
            name: m.name,
            isDefault:
              catalog.defaultModel?.providerID === String(m.providerID) &&
              catalog.defaultModel?.id === String(m.id),
          })),
      )
      process.stdout.write(
        `${JSON.stringify({ defaultModel: catalog.defaultModel, models }, null, 2)}\n`,
      )
      return 0
    }

    const model = selectModel(catalog, args.provider, args.model)

    let threadId = args.threadId
    if (!threadId) {
      const projectId = await resolveOrCreateProject(rpc.call, args.cwd)
      const created = await rpc.call<{ snapshot: { thread: { id: string } } }>('thread/create', {
        workspace: {
          kind: 'project',
          projectId,
          execution: args.worktree
            ? { kind: 'worktree', startingState: { type: 'working-tree' } }
            : { kind: 'local' },
        },
        operationId: crypto.randomUUID(),
      })
      threadId = created.snapshot.thread.id
      createdThreadId = threadId
    }

    emitJsonLine(args.json, { type: 'thread.started', threadId, model })

    const subscription = await rpc.call<{ subscriptionId: string }>('event/subscribe', {
      streams: [{ streamId: threadId, after: 'latest' }],
    })
    subscriptionId = subscription.subscriptionId

    const sseResponse = await transport.request(
      `http://agent.local/rpc/events?subscriptionId=${encodeURIComponent(subscriptionId)}&connectionId=${encodeURIComponent(connectionId)}`,
    )
    if (!sseResponse.ok || !sseResponse.body) {
      throw new Error(`SSE subscription failed with HTTP ${sseResponse.status}`)
    }

    const startedAt = Date.now()
    const turn = await rpc.call<{ turnId: string }>('turn/start', {
      threadId,
      inputId: crypto.randomUUID(),
      content: prompt,
      model,
      permissionConfig: PERMISSION_PRESETS[args.permission],
      taskMode: args.mode,
    })
    const turnId = turn.turnId
    emitJsonLine(args.json, { type: 'turn.started', threadId, turnId })

    let streamedText = ''
    const completedTexts: string[] = []
    const toolCalls: Array<{
      callID: string
      tool: string
      state: string
      durationMs: number | null
      error: string | null
    }> = []
    let totalUsage: TurnUsageSummary | undefined
    let turnError: string | undefined
    let finished = false

    const reader = sseResponse.body.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    const deadline = startedAt + args.timeoutMs

    try {
      while (!finished) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          throw new Error(`Turn ${turnId} timed out after ${args.timeoutMs}ms`)
        }
        const next = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Turn ${turnId} timed out`)), remaining),
          ),
        ])
        if (next.done) break

        buffered += decoder.decode(next.value, { stream: true })
        const frames = buffered.split(/\r?\n\r?\n/)
        buffered = frames.pop() ?? ''

        for (const frame of frames) {
          const dataLine = frame
            .split(/\r?\n/)
            .find((line) => line.startsWith('data:'))
            ?.slice(5)
            .trim()
          if (!dataLine) continue

          const message = JSON.parse(dataLine) as {
            method?: string
            params?: { event?: Record<string, unknown> }
          }
          if (message.method !== 'event/next' || !message.params?.event) continue

          const rawEvent = message.params.event
          const eventType = typeof rawEvent.type === 'string' ? rawEvent.type : ''
          const envelope = STRICT_DELTA_EVENTS.has(eventType)
            ? decodeEventEnvelope(rawEvent)
            : rawEvent
          const payload = (envelope.payload ?? {}) as Record<string, any>
          const eventTurnId =
            typeof rawEvent.turnId === 'string'
              ? rawEvent.turnId
              : typeof payload.turnId === 'string'
                ? payload.turnId
                : typeof payload.turn?.id === 'string'
                  ? payload.turn.id
                  : typeof payload.item?.turnId === 'string'
                    ? payload.item.turnId
                    : undefined

          if (eventTurnId && eventTurnId !== turnId) continue

          if (eventType === 'item/agentMessage/delta' || eventType === 'plan/delta') {
            const delta = typeof payload.delta === 'string' ? payload.delta : ''
            streamedText += delta
            emitJsonLine(args.json, { type: eventType, delta })
          } else if (eventType === 'tool/callStarted') {
            const item = payload.item as { callID: string; tool: string; command?: string | null }
            emitJsonLine(args.json, {
              type: 'tool.started',
              callID: item.callID,
              tool: item.tool,
              inputSummary: payload.inputSummary,
              ...(item.command ? { command: item.command } : {}),
            })
          } else if (eventType === 'tool/callCompleted' || eventType === 'tool/error') {
            const item = payload.item as {
              callID: string
              tool: string
              state: string
              durationMs: number | null
              error: string | null
            }
            toolCalls.push({
              callID: item.callID,
              tool: item.tool,
              state: item.state,
              durationMs: item.durationMs ?? null,
              error: item.error ?? payload.error?.message ?? null,
            })
            emitJsonLine(args.json, {
              type: eventType === 'tool/error' ? 'tool.error' : 'tool.completed',
              callID: item.callID,
              tool: item.tool,
              state: item.state,
              durationMs: item.durationMs ?? null,
              ...(item.error ? { error: item.error } : {}),
            })
          } else if (eventType === 'item/completed') {
            const item = payload.item as Record<string, any> | undefined
            if (item?.type === 'text' || item?.type === 'plan') {
              const text =
                typeof item.text === 'string'
                  ? item.text
                  : typeof item.markdown === 'string'
                    ? item.markdown
                    : ''
              if (text) completedTexts.push(text)
            }
            if (item?.usage && typeof item.usage === 'object') {
              totalUsage = accumulateUsage(totalUsage, item.usage as Record<string, unknown>)
            }
            emitJsonLine(args.json, { type: 'item.completed', item })
          } else if (BLOCKING_INTERACTION_EVENTS.has(eventType)) {
            emitJsonLine(args.json, { type: 'interaction.requested', eventType, payload })
            turnError = `Blocked on interactive ${eventType}; re-run with --permission full-access for unattended runs.`
            finished = true
            break
          } else if (eventType === 'turn/completed') {
            finished = true
            break
          } else if (eventType === 'turn/failed' || eventType === 'turn/interrupted') {
            turnError =
              typeof payload.error?.message === 'string'
                ? payload.error.message
                : typeof payload.reason === 'string'
                  ? payload.reason
                  : `Turn ended with ${eventType}`
            finished = true
            break
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }

    const elapsedMs = Date.now() - startedAt
    const finalText = completedTexts.at(-1) ?? streamedText

    if (args.json) {
      emitJsonLine(true, {
        type: 'result',
        ok: !turnError,
        threadId,
        turnId,
        model,
        elapsedMs,
        toolCalls,
        ...(totalUsage ? { usage: totalUsage } : {}),
        text: finalText,
        ...(turnError ? { error: turnError } : {}),
      })
    } else {
      if (finalText) {
        process.stdout.write(`${finalText.trimEnd()}\n`)
      }
      if (turnError) {
        process.stderr.write(`Error: ${turnError}\n`)
      }
      process.stderr.write(
        `[pidex-exec] thread=${threadId} model=${model.providerID}/${model.id} elapsedMs=${elapsedMs} tools=${toolCalls.length}${totalUsage ? ` usage=${JSON.stringify(totalUsage)}` : ''}\n`,
      )
    }

    return turnError ? 1 : 0
  } finally {
    if (subscriptionId) {
      await rpc.call('event/unsubscribe', { subscriptionId }).catch(() => undefined)
    }
    if (args.deleteThread && createdThreadId) {
      await rpc
        .call('thread/delete', {
          threadId: createdThreadId,
          operationId: crypto.randomUUID(),
        })
        .catch(() => undefined)
    }
    await transport.dispose()
  }
}

const exitCode = await main().catch((cause) => {
  process.stderr.write(`Error: ${cause instanceof Error ? cause.message : String(cause)}\n`)
  return 1
})
process.exit(exitCode)
