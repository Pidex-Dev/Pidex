import { z, type ZodType } from 'zod'
import {
  AgentError,
  type SubagentProfile,
  type TaskMode,
  type ToolAuthorizationScope,
  type ToolInvocation,
} from '../Domain'
import { WorkspaceService, type WorkspaceFileRevision } from '../workspace/WorkspaceService'
import { isReadOnlyTaskMode, type PermissionConfig, type SandboxMode } from '@pidex/shared/thread'
import type { Model } from '@pidex/model-schema'
import type { ToolExecutionMode as PiToolExecutionMode } from '../orchestration/harness/AgentTypes'
import type { Tool as PiAiTool } from '@earendil-works/pi-ai'
import { isAbsolute, resolve } from 'node:path'
import type { ToolingResolver, ToolProcessRunner } from './ToolingRuntime'
import { nativeGlobWorkspace } from './NativeWorkspaceSearch'
import { grepWorkspace, resolveRipgrep, ripgrep, searchPaths } from './Grep/GrepEngine'
import {
  requestPermissionsDefinition,
  type RequestPermissionsInput,
} from './RequestPermissions/Definition'
import { toolCatalogSummary, toolSearchDefinition } from './ToolSearch/Definition'
import { applyEditsText } from './Edit/ApplyEditText'
import { subagentToolDefinitions } from './Delegation/Definitions'
import { applyPatchDefinition } from './ApplyPatch/Definition'
import type { TurnPatchMutationFile } from '../patch/TurnPatchTypes'
import { diffLines } from 'diff'
import type { FileAccessProfile } from '../permission/ExecutionPolicy'
import { fileAccessProfileFromV4 } from '../permission/ExecutionPolicy'
import type { ComputerOperationRecovery } from '../nodeRepl/Protocol'

export type ToolCapabilities = {
  filesystem: 'none' | 'read' | 'workspace-write' | 'host-write'
  network: 'none' | 'declared' | 'unrestricted'
  process: boolean
  externalState: boolean
  userInteraction: boolean
  /**
   * Host-registered fact: the tool only reads existing state. Starting a helper
   * process (for example a search binary) stays an implementation detail, not
   * a mutation. Only built-in definitions set this; model input, MCP
   * annotations and plugin metadata never grant investigation access.
   */
  readOnly?: boolean
}

export type ApprovalStrategy = 'policy' | 'always-review' | 'never-review'
export type ToolVisibility = 'eager' | 'deferred' | 'internal'
export type ToolExecutionMode = PiToolExecutionMode
export type ToolProgress = {
  message: string
  completed?: number
  total?: number
  details?: unknown
}
export type ToolStructuredResult = {
  artifacts?: Array<{ artifactId: string; name: string; mimeType: string; data: string }>
  images?: Array<{ type: 'image'; data: string; mimeType: string }>
  content: string
  details: unknown
  addedToolNames?: string[]
  /** Stops the agent loop after this batch; used by durable pauses. */
  terminate?: boolean
}
export type PromptFactory = string | ((context: ToolContext) => string)
export type { ToolAffectedPath, ToolAuthorizationScope, ToolReviewSummary } from '../Domain'
export type ToolFileSnapshots = {
  get(path: string): Promise<WorkspaceFileRevision | undefined>
  set(path: string, revision: WorkspaceFileRevision): Promise<void>
  invalidate(paths: readonly string[]): Promise<void>
}
export type ToolInputInspection = {
  permissionFacts?: ToolInvocation['permissionFacts']
  grantsForbidden?: boolean
  fileDiffs?: ToolInvocation['fileDiffs']
  authorizationScope: ToolAuthorizationScope
  configWrites?: readonly {
    path: string
    content: string
    scope: 'user' | 'project'
  }[]
}

/** Minimal structural pause request; the runtime owns durable checkpointing. */
export type ToolPauseRequest = {
  kind: 'permission'
  toolCallID: string
  checkpoint: {
    state: string
    interruption: unknown
    toolCallID: string
    authorizationFingerprint?: string
  }
}
export type ToolOrigin =
  | { kind: 'builtin' }
  | {
      kind: 'mcp'
      serverName: string
      rawToolName: string
      generation: number
      configurationHash?: string
    }

export interface ToolCatalogEntry<Input = unknown, Output = unknown> {
  /** The sole canonical name exposed to the model. */
  available?: () => boolean
  sdkName: string
  /** Internal execution name. It is never exposed to the model. */
  name?: string
  schema: ZodType<Input>
  description: PromptFactory
  capabilities: ToolCapabilities
  allowedModes: readonly TaskMode[]
  allowedProfiles: readonly SubagentProfile[]
  approvalStrategy: ApprovalStrategy
  visibility: ToolVisibility
  executionMode: ToolExecutionMode
  inputSchema: Record<string, unknown>
  /** Normalizes provider-specific argument encodings before schema validation. */
  prepareArguments?: (input: unknown) => unknown
  /** Optional provider-side constrained sampling configuration. */
  constrainedSampling?: PiAiTool['constrainedSampling']
  /** Structured provenance used by permission and routing decisions. */
  origin?: ToolOrigin
  /** Host-only inspection performed before hooks, review, or execution. */
  inspectInput?: (
    input: Input,
    context: ToolContext,
  ) => ToolInputInspection | undefined | Promise<ToolInputInspection | undefined>
  progress?: (input: Input, context: ToolContext) => ToolProgress | undefined
  auditResult?: (output: Output) => unknown
  formatResult?: (output: Output, context: ToolContext) => ToolStructuredResult
}

export interface ToolContext {
  subagentLifecycle?: (name: string, input: Record<string, unknown>) => Promise<unknown>
  signal: AbortSignal
  taskMode: TaskMode
  profile?: SubagentProfile
  workspace: WorkspaceService
  permissionConfig: PermissionConfig
  model: Model.Ref
  onProgress?: (progress: ToolProgress) => void
  deferredTools?: readonly ToolCatalogEntry[]
  readSnapshot?: { mtimeMs: number; sha256: string }
  fileSnapshots?: ToolFileSnapshots
  /** Host-inspected scope for the exact input being executed. */
  computerGrant?: 'chat' | 'persistent'
  /**
   * Host-only: the internal operation recorded in an approval checkpoint. When
   * present the entry resumes only that operation instead of re-running a script.
   */
  computerRecovery?: ComputerOperationRecovery
  /** Host-only: grant resolved with the approval, consumed by the recovered read. */
  approvedComputerGrant?: 'chat' | 'persistent'
  /** Host-only: arrange a durable approval pause from inside tool execution. */
  requestPause?: (approval: ToolPauseRequest) => Promise<void>
  authorizationScope?: ToolAuthorizationScope
  fileSaved?: (input: { filePath: string; content: string }) => Promise<void>
  /** Persists host-only reversible evidence after a successful managed file mutation. */
  recordMutation?: (files: readonly TurnPatchMutationFile[]) => Promise<void>
  resolveTooling?: ToolingResolver
  runToolProcess?: ToolProcessRunner
  /** Host-owned identity for this invocation. It is never derived from model input. */
  invocation?: Readonly<{
    threadID: string
    turnID: string
    agentID: string
    toolCallID: string
  }>
}

export interface ToolDefinition<Input = unknown, Output = unknown> extends ToolCatalogEntry<
  Input,
  Output
> {
  execute(input: Input, context: ToolContext): Promise<Output>
}

const allModes = ['chat', 'plan'] as const
const allProfiles = ['main', 'default', 'explorer', 'worker'] as const
const noCapabilities = (): ToolCapabilities => ({
  filesystem: 'none',
  network: 'none',
  process: false,
  externalState: false,
  userInteraction: false,
  readOnly: false,
})
const jsonObject = (properties: Record<string, unknown>, required?: string[]) => ({
  type: 'object',
  properties,
  additionalProperties: false,
  ...(required ? { required } : {}),
})
const editOperationSchema = z
  .object({
    oldText: z.string().min(1),
    newText: z.string(),
  })
  .strict()
const editInputSchema = z
  .object({
    path: z.string().min(1),
    edits: z.array(editOperationSchema).min(1),
  })
  .strict()
const normalizePiEditInput = (input: unknown) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const edits = (input as Record<string, unknown>).edits
  if (typeof edits !== 'string') return input
  try {
    return { ...input, edits: JSON.parse(edits) }
  } catch {
    return input
  }
}
const shellSchema = z
  .object({
    command: z.string().min(1).max(32_000),
    cwd: z.string().min(1).optional(),
    timeout: z.number().positive().max(600_000).optional(),
    description: z.string().max(2_000).optional(),
    additionalPermissions: z
      .object({
        readPaths: z.array(z.string().min(1)).optional(),
        writePaths: z.array(z.string().min(1)).optional(),
        networkDomains: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
const shellInputSchema = jsonObject(
  {
    command: { type: 'string', maxLength: 32_000 },
    cwd: { type: 'string' },
    timeout: { type: 'number', maximum: 600_000 },
    description: { type: 'string', maxLength: 2_000 },
    additionalPermissions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        readPaths: { type: 'array', items: { type: 'string' } },
        writePaths: { type: 'array', items: { type: 'string' } },
        networkDomains: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  ['command'],
)

export const lineChangeSummary = (before: string, after: string) => {
  let additions = 0
  let deletions = 0
  for (const part of diffLines(before, after)) {
    if (part.added) additions += part.count ?? 0
    if (part.removed) deletions += part.count ?? 0
  }
  return { additions, deletions }
}

export {
  requestPermissionsDefinition,
  type RequestPermissionsInput,
  toolCatalogSummary,
}

const builtinTools = (): ToolDefinition<any, any>[] => [
  {
    sdkName: 'Read',
    name: 'workspace.read',
    description:
      'Read a UTF-8 text file and retain its full snapshot for subsequent edits. Returned text is paginated; continue reading when needed. For outside-workspace files, call with an absolute path and let the host authorize access.',
    schema: z
      .object({
        file_path: z.string().min(1),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(10_000).optional(),
      })
      .strict(),
    inputSchema: jsonObject(
      {
        file_path: {
          type: 'string',
          description:
            'An observed existing UTF-8 file path, relative to the workspace or absolute where host policy permits. Files only, not directories or guessed paths.',
        },
        offset: { type: 'number', minimum: 0 },
        limit: { type: 'number', minimum: 1, maximum: 10_000 },
      },
      ['file_path'],
    ),
    capabilities: { ...noCapabilities(), filesystem: 'read', readOnly: true },
    allowedModes: allModes,
    allowedProfiles: allProfiles,
    approvalStrategy: 'policy',
    visibility: 'eager',
    executionMode: 'parallel',
    progress: (input) => ({ message: `正在读取 ${input.file_path}` }),
    execute: async (input, context) => {
      const file = await context.workspace.readEditorFile(input.file_path)
      const offset = input.offset ?? 0
      const limit = input.limit ?? 400
      const lines = file.content.split(/\r?\n/)
      return {
        path: file.path,
        content: lines.slice(offset, offset + limit).join('\n'),
        offset,
        lineCount: lines.length,
        truncated: offset + limit < lines.length,
        sizeBytes: file.sizeBytes,
        snapshot: file.revision,
      }
    },
  },
  applyPatchDefinition,
  {
    sdkName: 'Write',
    name: 'workspace.write',
    description:
      'Create or fully overwrite a file. Read existing files first; the executor maintains snapshots. For outside-workspace files, use absolute paths and let the host authorize access.',
    schema: z.object({ file_path: z.string().min(1), content: z.string() }).strict(),
    inputSchema: jsonObject(
      {
        file_path: {
          type: 'string',
          description:
            'Target file path. Existing files require a successful Read of the same path; new files can be written directly.',
        },
        content: { type: 'string' },
      },
      ['file_path', 'content'],
    ),
    capabilities: { ...noCapabilities(), filesystem: 'workspace-write', externalState: true },
    allowedModes: ['chat'],
    allowedProfiles: ['main', 'default', 'worker'],
    approvalStrategy: 'policy',
    visibility: 'eager',
    executionMode: 'sequential',
    progress: (input) => ({ message: `正在写入 ${input.file_path}` }),
    execute: async (input, context) => {
      let current
      try {
        current = await context.workspace.readEditorFile(input.file_path)
      } catch (cause) {
        if (!(cause instanceof AgentError) || cause.code !== 'WORKSPACE_PATH_NOT_FOUND') throw cause
      }
      if (!current) {
        const created = await context.workspace.applyPatch({
          operation: 'create',
          path: input.file_path,
          content: input.content,
        })
        await context
          .recordMutation?.([
            {
              operation: 'create',
              path: created.path,
              beforeContent: null,
              afterContent: input.content.startsWith('\uFEFF')
                ? input.content.slice(1)
                : input.content,
              beforeSha256: null,
              afterSha256: created.afterSha256,
            },
          ])
          .catch(() => undefined)
        await context.fileSaved?.({ filePath: input.file_path, content: input.content })
        return {
          operation: 'write' as const,
          mutation: 'create' as const,
          path: created.path,
          additions: created.additions,
          deletions: created.deletions,
          beforeSha256: created.beforeSha256,
          afterSha256: created.afterSha256,
        }
      }
      if (
        !context.readSnapshot ||
        context.readSnapshot.sha256 !== current.revision.sha256 ||
        context.readSnapshot.mtimeMs !== current.revision.mtimeMs
      )
        throw new AgentError(
          'WORKSPACE_FILE_STALE',
          '文件内容已变化或缺少完整 Read 快照，拒绝覆写',
          409,
          { currentRevision: current.revision },
        )
      const saved = await context.workspace.saveEditorFile(
        input.file_path,
        input.content,
        context.readSnapshot,
      )
      if (saved.outcome === 'conflict')
        throw new AgentError('WORKSPACE_FILE_STALE', '文件在写入前发生变化，拒绝覆写', 409, {
          currentRevision: saved.revision,
        })
      await context
        .recordMutation?.([
          {
            operation: 'update',
            path: current.path,
            beforeContent: current.content,
            afterContent: input.content.startsWith('\uFEFF')
              ? input.content.slice(1)
              : input.content,
            beforeSha256: current.revision.sha256,
            afterSha256: saved.revision!.sha256,
          },
        ])
        .catch(() => undefined)
      await context.fileSaved?.({ filePath: current.path, content: input.content })
      const changes = lineChangeSummary(current.content, input.content)
      return {
        operation: 'write',
        mutation: 'update',
        path: current.path,
        ...changes,
        beforeSha256: current.revision.sha256,
        afterSha256: saved.revision!.sha256,
        revision: saved.revision!,
      }
    },
    formatResult: (output) => ({
      content: `已写入 ${output.path}（+${output.additions} -${output.deletions}）`,
      details: {
        operation: output.operation,
        mutation: output.mutation,
        path: output.path,
        additions: output.additions,
        deletions: output.deletions,
      },
    }),
  },
  {
    sdkName: 'Edit',
    name: 'workspace.edit',
    description:
      'Apply precise atomic edits to a previously read file. Each oldText must match uniquely, and all edits refer to the same original text. Absolute outside-workspace paths are subject to host authorization. On stale or ambiguous context, Read again and rebuild the edits.',
    schema: editInputSchema,
    inputSchema: jsonObject(
      {
        path: {
          type: 'string',
          description:
            'Existing file path previously read with Read. Base edits on the latest complete original snapshot.',
        },
        edits: {
          type: 'array',
          minItems: 1,
          description:
            'Atomic edits against the same original text. Include enough oldText context for a unique match.',
          items: jsonObject(
            {
              oldText: {
                type: 'string',
                minLength: 1,
                description: 'Exact original text occurring uniquely in the file.',
              },
              newText: {
                type: 'string',
                description: 'Replacement text; an empty string deletes oldText.',
              },
            },
            ['oldText', 'newText'],
          ),
        },
      },
      ['path', 'edits'],
    ),
    prepareArguments: normalizePiEditInput,
    capabilities: { ...noCapabilities(), filesystem: 'workspace-write', externalState: true },
    allowedModes: ['chat'],
    allowedProfiles: ['main', 'default', 'worker'],
    approvalStrategy: 'policy',
    visibility: 'eager',
    executionMode: 'sequential',
    progress: (input) => ({
      message: `正在编辑 ${input.path}`,
      completed: 0,
      total: input.edits.length,
    }),
    execute: async (input, context) => {
      const current = await context.workspace.readEditorFile(input.path)
      if (
        !context.readSnapshot ||
        context.readSnapshot.sha256 !== current.revision.sha256 ||
        context.readSnapshot.mtimeMs !== current.revision.mtimeMs
      )
        throw new AgentError(
          'WORKSPACE_FILE_STALE',
          '文件内容已变化或缺少完整 Read 快照，拒绝编辑',
          409,
          { currentRevision: current.revision },
        )
      const content = applyEditsText(current.content, input.edits)
      const saved = await context.workspace.saveEditorFile(
        input.path,
        content,
        context.readSnapshot,
      )
      if (saved.outcome === 'conflict')
        throw new AgentError('WORKSPACE_FILE_STALE', '文件在编辑前发生变化，拒绝写入', 409, {
          currentRevision: saved.revision,
        })
      await context
        .recordMutation?.([
          {
            operation: 'update',
            path: current.path,
            beforeContent: current.content,
            afterContent: content,
            beforeSha256: current.revision.sha256,
            afterSha256: saved.revision!.sha256,
          },
        ])
        .catch(() => undefined)
      await context.fileSaved?.({ filePath: current.path, content })
      const changes = lineChangeSummary(current.content, content)
      return {
        operation: 'edit',
        path: current.path,
        ...changes,
        beforeSha256: current.revision.sha256,
        afterSha256: saved.revision!.sha256,
        revision: saved.revision!,
      }
    },
    formatResult: (output) => ({
      content: `已编辑 ${output.path}（+${output.additions} -${output.deletions}）`,
      details: {
        operation: output.operation,
        path: output.path,
        additions: output.additions,
        deletions: output.deletions,
      },
    }),
  },
  {
    sdkName: 'Glob',
    name: 'workspace.glob',
    description:
      'Find files by glob using managed or local ripgrep, with bounded native search as fallback. path defaults to .; prefer workspace-relative directories. Absolute directories are subject to host policy, including outside-workspace access.',
    schema: z
      .object({
        pattern: z.string().min(1).max(1_000),
        path: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .strict(),
    inputSchema: jsonObject(
      {
        pattern: {
          type: 'string',
          maxLength: 1_000,
          description: 'Glob pattern matching filenames or relative paths.',
        },
        path: {
          type: 'string',
          description: 'Optional existing directory, not a file. Filter filenames with pattern.',
        },
        limit: { type: 'number', minimum: 1, maximum: 500 },
      },
      ['pattern'],
    ),
    capabilities: { ...noCapabilities(), filesystem: 'read', process: true, readOnly: true },
    allowedModes: allModes,
    allowedProfiles: allProfiles,
    approvalStrategy: 'policy',
    visibility: 'eager',
    executionMode: 'parallel',
    progress: (input) => ({ message: `正在匹配 ${input.pattern}` }),
    execute: async (input, context) => {
      const targets = await searchPaths(context, input.path)
      const limit = input.limit ?? 200
      const resolution = await resolveRipgrep(context)
      if (!resolution.available) {
        const results = await Promise.all(
          targets.map((target) =>
            nativeGlobWorkspace({ ...input, limit: 500 }, context, target.nativeTarget),
          ),
        )
        const all = results
          .flatMap((result) => result.matches)
          .sort((left, right) => left.localeCompare(right))
        return {
          matches: all.slice(0, limit),
          truncated: results.some((result) => result.truncated) || all.length > limit,
          visited: results.reduce((sum, result) => sum + result.visited, 0),
          engine: 'native-fallback' as const,
        }
      }
      const all: string[] = []
      const searches = await Promise.all(
        targets.map(async (target) => ({
          target,
          result: await ripgrep(
            context,
            resolution.path,
            [
              '--files',
              '--null',
              '--color',
              'never',
              '--sort',
              'path',
              '--glob',
              input.pattern,
              '--',
              target.target,
            ],
            target.root,
          ),
        })),
      )
      for (const { target, result } of searches) {
        all.push(
          ...result.stdout
            .toString('utf8')
            .split('\0')
            .filter(Boolean)
            .map((path) =>
              context.workspace.displayPath(
                isAbsolute(path) ? resolve(path) : resolve(target.root, path),
              ),
            ),
        )
      }
      all.sort((left, right) => left.localeCompare(right))
      return {
        matches: all.slice(0, limit),
        truncated: all.length > limit,
        visited: all.length,
        engine: 'ripgrep' as const,
      }
    },
  },
  {
    sdkName: 'Grep',
    name: 'workspace.grep',
    description:
      'Perform bounded regular-expression content search using managed or local ripgrep, with bounded native search as fallback. path defaults to .; prefer workspace-relative directories. Supports file filtering, context and output modes. Absolute directories are subject to host policy.',
    schema: z
      .object({
        pattern: z.string().min(1).max(10_000),
        path: z.string().optional(),
        glob: z.string().max(1_000).optional(),
        output_mode: z.enum(['content', 'files_with_matches', 'count']).default('content'),
        '-A': z.number().int().min(0).max(100).optional(),
        '-B': z.number().int().min(0).max(100).optional(),
        '-C': z.number().int().min(0).max(100).optional(),
        context: z.number().int().min(0).max(100).optional(),
        '-n': z.boolean().optional(),
        '-i': z.boolean().optional(),
        type: z.string().max(100).optional(),
        head_limit: z.number().int().min(1).max(1_000).default(200),
        offset: z.number().int().min(0).default(0),
        multiline: z.boolean().default(false),
      })
      .strict(),
    inputSchema: jsonObject(
      {
        pattern: { type: 'string', maxLength: 10_000 },
        path: {
          type: 'string',
          description: 'Optional existing directory, not a file. Restrict filenames with glob.',
        },
        glob: {
          type: 'string',
          maxLength: 1_000,
          description: 'Optional file glob filter. Do not pass a file as path.',
        },
        output_mode: { enum: ['content', 'files_with_matches', 'count'], default: 'content' },
        '-A': { type: 'integer', minimum: 0, maximum: 100 },
        '-B': { type: 'integer', minimum: 0, maximum: 100 },
        '-C': { type: 'integer', minimum: 0, maximum: 100 },
        context: { type: 'integer', minimum: 0, maximum: 100 },
        '-n': { type: 'boolean' },
        '-i': { type: 'boolean' },
        type: { type: 'string', maxLength: 100 },
        head_limit: { type: 'integer', minimum: 1, maximum: 1_000, default: 200 },
        offset: { type: 'integer', minimum: 0, default: 0 },
        multiline: { type: 'boolean', default: false },
      },
      ['pattern'],
    ),
    capabilities: { ...noCapabilities(), filesystem: 'read', process: true, readOnly: true },
    allowedModes: allModes,
    allowedProfiles: allProfiles,
    approvalStrategy: 'policy',
    visibility: 'eager',
    executionMode: 'parallel',
    progress: (input) => ({ message: `正在搜索 ${input.pattern}` }),
    execute: grepWorkspace,
  },
  ...(['Bash', 'PowerShell'] as const).map((sdkName): ToolDefinition<any, any> => ({
    sdkName,
    name: sdkName,
    description:
      sdkName === 'Bash'
        ? 'Execute Bash commands on the host as the current user, with workspace cwd by default and normal host authorization. No OS filesystem or network isolation. In Plan and Grill, investigate only; do not implement changes.'
        : 'Execute PowerShell commands on the host as the current user, with workspace cwd by default and normal host authorization. No OS filesystem or network isolation. In Plan and Grill, investigate only; do not implement changes.',
    schema: shellSchema,
    inputSchema: shellInputSchema,
    capabilities: {
      filesystem: 'host-write',
      network: 'declared',
      process: true,
      externalState: true,
      userInteraction: false,
    },
    allowedModes: allModes,
    allowedProfiles: ['main', 'default', 'explorer', 'worker'],
    approvalStrategy: 'policy',
    visibility: 'eager',
    executionMode: 'sequential',
    progress: () => ({ message: `正在执行 ${sdkName}` }),
    execute: async () => {
      throw new AgentError('SHELL_EXECUTOR_REQUIRED', `${sdkName} 必须经过统一执行器`, 500)
    },
  })),
  toolSearchDefinition,
  requestPermissionsDefinition,
  ...subagentToolDefinitions,
]

export const toolMayMutate = (tool: ToolCatalogEntry) =>
  tool.capabilities.readOnly !== true &&
  (tool.capabilities.filesystem === 'workspace-write' ||
    tool.capabilities.filesystem === 'host-write' ||
    tool.capabilities.externalState)
const isShell = (tool: ToolCatalogEntry) => tool.sdkName === 'Bash' || tool.sdkName === 'PowerShell'
export const toolAllowedInTaskMode = (tool: ToolCatalogEntry, mode: TaskMode) =>
  // Grill mirrors Plan's investigation surface; mutating tools stay out even if
  // a definition forgets to narrow its allowedModes. Shell stays available so
  // the existing risk, rule, hook and approval chain decides each command.
  (tool.allowedModes.includes(mode) || (mode === 'grill' && tool.allowedModes.includes('plan'))) &&
  (!isReadOnlyTaskMode(mode) || isShell(tool) || !toolMayMutate(tool))
export const toolAllowedForFileAccess = (tool: ToolCatalogEntry, profile: FileAccessProfile) =>
  profile !== 'read-only' ||
  isShell(tool) ||
  (tool.capabilities.filesystem !== 'workspace-write' &&
    tool.capabilities.filesystem !== 'host-write')

export class ToolCatalog {
  private readonly tools = new Map<string, ToolDefinition<any, any>>()
  private readonly internalNames = new Map<string, string>()

  constructor(definitions: ToolDefinition<any, any>[] = builtinTools()) {
    for (const definition of definitions) this.register(definition)
  }

  register(tool: ToolDefinition<any, any>) {
    if (
      !tool.sdkName ||
      !tool.schema ||
      !tool.execute ||
      !tool.capabilities ||
      !tool.visibility ||
      !tool.executionMode
    )
      throw new AgentError('INVALID_TOOL_DEFINITION', '工具定义不完整', 500)
    const internalName = tool.name ?? tool.sdkName
    if (
      this.tools.has(tool.sdkName) ||
      this.internalNames.has(tool.sdkName) ||
      this.internalNames.has(internalName) ||
      this.tools.has(internalName)
    )
      throw new AgentError(
        'TOOL_ALREADY_REGISTERED',
        `工具 ${tool.sdkName}/${internalName} 已注册`,
        409,
      )
    const frozen = Object.freeze({
      ...tool,
      name: internalName,
      allowedModes: [...tool.allowedModes],
      allowedProfiles: [...tool.allowedProfiles],
      capabilities: Object.freeze({ ...tool.capabilities }),
    })
    this.tools.set(tool.sdkName, frozen)
    this.internalNames.set(internalName, tool.sdkName)
  }

  all() {
    return [...this.tools.values()]
  }

  list(
    mode?: TaskMode,
    sandboxMode: SandboxMode = 'workspace-write',
    profile: SubagentProfile = 'main',
  ) {
    const fileAccess = fileAccessProfileFromV4(sandboxMode)
    return [...this.tools.values()].filter(
      (tool) =>
        (tool.available?.() ?? true) &&
        (!mode || toolAllowedInTaskMode(tool, mode)) &&
        tool.allowedProfiles.includes(profile) &&
        toolAllowedForFileAccess(tool, fileAccess),
    )
  }

  deferred(
    mode?: TaskMode,
    sandboxMode: SandboxMode = 'workspace-write',
    profile: SubagentProfile = 'main',
  ) {
    return this.list(mode, sandboxMode, profile).filter((tool) => tool.visibility === 'deferred')
  }

  get(name: string) {
    const tool = this.tools.get(name) ?? this.tools.get(this.internalNames.get(name) ?? '')
    if (!tool) throw new AgentError('TOOL_NOT_FOUND', `工具 ${name} 不存在`, 404)
    return tool
  }

  async execute(name: string, input: Record<string, unknown>, context: ToolContext) {
    const tool = this.get(name)
    if (!toolAllowedInTaskMode(tool, context.taskMode))
      throw new AgentError(
        'TOOL_NOT_ALLOWED_IN_MODE',
        `工具 ${name} 不允许在 ${context.taskMode} 模式执行`,
        403,
      )
    if (!tool.allowedProfiles.includes(context.profile ?? 'main'))
      throw new AgentError(
        'TOOL_NOT_ALLOWED_FOR_PROFILE',
        `工具 ${name} 不允许当前 Agent profile 使用`,
        403,
      )
    const fileAccess = fileAccessProfileFromV4(context.permissionConfig.sandboxMode)
    if (!toolAllowedForFileAccess(tool, fileAccess))
      throw new AgentError(
        'TOOL_NOT_ALLOWED_IN_SANDBOX',
        `工具 ${name} 不允许在 ${fileAccess} 文件访问范围执行`,
        403,
      )
    if (context.signal.aborted) throw new AgentError('RUN_ABORTED', '任务已停止', 499)
    const parsed = tool.schema.safeParse(input)
    if (!parsed.success) throw new AgentError('INVALID_TOOL_INPUT', parsed.error.message, 400)
    const progress = tool.progress?.(parsed.data, context)
    if (progress) context.onProgress?.(progress)
    return tool.execute(parsed.data, {
      ...context,
      deferredTools:
        context.deferredTools ??
        this.deferred(
          context.taskMode,
          context.permissionConfig.sandboxMode,
          context.profile ?? 'main',
        ),
    })
  }
}

/** Canonical Skill allowlists are exact and cannot reactivate removed aliases. */
export const allowedToolNameMatches = (name: string, allowedTools: readonly string[]) =>
  allowedTools.includes(name)
export const toolNameMatches = (
  tool: Pick<ToolCatalogEntry, 'sdkName'>,
  allowedTools: readonly string[],
) => allowedToolNameMatches(tool.sdkName, allowedTools)

/** @deprecated Use ToolCatalog. */
export class ToolRegistry extends ToolCatalog {}

/** Immutable per-turn view combining process-wide built-ins with scoped tools. */
export class TurnToolCatalog extends ToolCatalog {
  constructor(base: ToolCatalog, scoped: readonly ToolDefinition[]) {
    super([...base.all(), ...scoped])
  }
}
