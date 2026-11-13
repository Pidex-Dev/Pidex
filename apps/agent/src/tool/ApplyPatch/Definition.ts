import { createHash } from 'node:crypto'
import { filePathProtection } from '../../permission/FilePathProtection'
import { relative } from 'node:path'
import { z } from 'zod'
import {
  AgentError,
  type ToolAffectedPath,
  type ToolAuthorizationScope,
  type ToolReviewSummary,
} from '../../Domain'
import type {
  EditorMutation,
  WorkspaceFileRevision,
  WorkspaceMutationPathInspection,
} from '../../workspace/WorkspaceService'
import type { ToolContext, ToolDefinition, ToolInputInspection } from '../ToolRegistry'
import { applyPatchText } from './ApplyPatchText'
import { parseApplyPatch, type ApplyPatchChunk, type ApplyPatchOperation } from './ParseApplyPatch'
import { buildFileDiff } from '../../patch/TurnPatchService'

const MAX_PATCH_BYTES = 1024 * 1024
const MAX_AFFECTED_FILES = 100
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_STAGED_BYTES = 50 * 1024 * 1024

const APPLY_PATCH_LARK_GRAMMAR = String.raw`start: begin_patch operation+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?
operation: add_file | update_file | delete_file
add_file: "*** Add File: " filename LF add_line+
update_file: "*** Update File: " filename LF (move_to change* | change+)
delete_file: "*** Delete File: " filename LF
move_to: "*** Move to: " filename LF
filename: /(.+)/
add_line: "+" /(.*)/ LF
change: change_context change_line+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF
%import common.LF`

const applyPatchInputSchema = z
  .object({
    patch: z.string().min(1).max(MAX_PATCH_BYTES),
  })
  .strict()

type ApplyPatchInput = z.infer<typeof applyPatchInputSchema>

type PreparedOperation = {
  operation: 'create' | 'update' | 'delete'
  /** Path exactly as the patch requested; the snapshot key for Read/Update/Delete. */
  requestedPath: string
  /** Workspace-safe display path used in results and authorization scope. */
  path: string
  workspacePath: string
  canonicalPath: string
  /** Final content of the target file; empty for delete. */
  content: string
  beforeContent: string | null
  expectedRevision?: WorkspaceFileRevision
  additions: number
  deletions: number
  hunkCount: number
  /** Display path of the move source (present on the created target). */
  movedFrom?: string
  /** Display path of the move target (present on the deleted source). */
  movedTo?: string
}

type PreparedPatch = {
  operations: readonly PreparedOperation[]
  authorizationScope: ToolAuthorizationScope
  configWrites: NonNullable<ToolInputInspection['configWrites']>
}

type ConfigWrite = NonNullable<ToolInputInspection['configWrites']>[number]

export type ApplyPatchOutput = {
  operation: 'apply_patch'
  files: readonly {
    operation: 'create' | 'update' | 'delete'
    path: string
    additions: number
    deletions: number
    beforeSha256: string | null
    /** Null after a delete, because the file no longer exists. */
    afterSha256: string | null
    /** Null after a delete, because the file no longer exists. */
    revision: WorkspaceFileRevision | null
    movedFrom?: string
    movedTo?: string
  }[]
  summary: ToolReviewSummary
}

const canonicalKey = (path: string) => {
  const normalized = path.replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const safeWorkspacePath = (context: ToolContext, inspection: WorkspaceMutationPathInspection) => {
  if (inspection.path.startsWith('@')) return inspection.path
  const owner = context.workspace.rootForPath(inspection.canonicalPath)
  if (!owner) {
    // Full access resolves the target to an absolute display path, which is the
    // only identifiable label for a file outside every workspace root.
    return context.workspace.displayPath(inspection.canonicalPath)
  }
  const child = relative(owner.path, inspection.canonicalPath).replaceAll('\\', '/')
  if (owner.path === context.workspace.rootPath) return child
  const rootIndex = context.workspace.workspaceRoots.findIndex(
    (root) => canonicalKey(root.path) === canonicalKey(owner.path),
  )
  const rootLabel = owner.folderId ?? `root-${Math.max(0, rootIndex) + 1}`
  return `@workspace/${rootLabel}/${child}`
}

const protectedPath = (_context: ToolContext, inspection: WorkspaceMutationPathInspection) =>
  filePathProtection(inspection.canonicalPath, inspection.path)

const countAddedFileLines = (content: string) =>
  content.endsWith('\n') ? content.slice(0, -1).split('\n').length : content.split('\n').length

const countContentLines = (content: string) =>
  content.length === 0 ? 0 : countAddedFileLines(content)

/** Move targets bypass the editor's BOM preservation, so carry it explicitly. */
const withSourceBom = (content: string, hadBom: boolean) =>
  hadBom && !content.startsWith('\uFEFF') ? `\uFEFF${content}` : content

const withoutBom = (content: string) => (content.startsWith('\uFEFF') ? content.slice(1) : content)

const chunkStats = (chunks: readonly ApplyPatchChunk[]) => ({
  additions: chunks.reduce((sum, chunk) => sum + chunk.additions, 0),
  deletions: chunks.reduce((sum, chunk) => sum + chunk.deletions, 0),
  hunkCount: chunks.length,
})

const operationStats = (operation: ApplyPatchOperation, beforeContent: string | null) => {
  if (operation.type === 'add') {
    return {
      additions: countAddedFileLines(operation.content),
      deletions: 0,
      hunkCount: 0,
    }
  }
  if (operation.type === 'delete') {
    return {
      additions: 0,
      deletions: beforeContent === null ? 0 : countContentLines(beforeContent),
      hunkCount: 0,
    }
  }
  return chunkStats(operation.chunks)
}

const staleError = (path: string): never => {
  throw new AgentError(
    'WORKSPACE_FILE_STALE',
    `无法更新 "${path}"：文件缺少完整 Read 快照或已在 Read 后发生变化。请重新 Read 所有受影响文件后再生成补丁。本次补丁未修改任何文件`,
    409,
  )
}

const configMutationError = (path: string): never => {
  throw new AgentError(
    'PATCH_PROTECTED_CONFIG',
    `补丁不能通过 Delete 或 Move 修改 Pidex 配置 "${path}"；请使用专用配置写入。本次补丁未修改任何文件`,
    403,
  )
}

const preflightError = (cause: unknown): never => {
  if (cause instanceof AgentError) {
    if (cause.message.includes('本次补丁未修改任何文件')) throw cause
    throw new AgentError(
      cause.code,
      `${cause.message}。请检查补丁路径并在必要时重新 Read；本次补丁未修改任何文件`,
      cause.status,
      cause.details,
    )
  }
  throw new AgentError(
    'PATCH_EXECUTION_FAILED',
    'apply_patch 预检失败。请重新 Read 所有受影响文件后重试；本次补丁未修改任何文件',
    500,
  )
}

const summarize = (operations: readonly PreparedOperation[]): ToolReviewSummary => ({
  fileCount: operations.length,
  hunkCount: operations.reduce((sum, operation) => sum + operation.hunkCount, 0),
  additions: operations.reduce((sum, operation) => sum + operation.additions, 0),
  deletions: operations.reduce((sum, operation) => sum + operation.deletions, 0),
})

const requireSnapshot = async (
  context: ToolContext,
  requestedPath: string,
  path: string,
  inspection: Extract<WorkspaceMutationPathInspection, { expectation: 'existing-file' }>,
): Promise<WorkspaceFileRevision> => {
  const snapshot = await context.fileSnapshots?.get(requestedPath)
  if (
    !snapshot ||
    snapshot.mtimeMs !== inspection.revision.mtimeMs ||
    snapshot.sha256 !== inspection.revision.sha256 ||
    (snapshot.rawSha256 !== undefined &&
      snapshot.rawSha256.toLowerCase() !== inspection.rawSha256) ||
    (snapshot.utf8Bom !== undefined && snapshot.utf8Bom !== inspection.utf8Bom)
  ) {
    return staleError(path)
  }
  return snapshot
}

const preparePatch = async (
  input: ApplyPatchInput,
  context: ToolContext,
): Promise<PreparedPatch> => {
  try {
    if (Buffer.byteLength(input.patch, 'utf8') > MAX_PATCH_BYTES) {
      throw new AgentError('PATCH_LIMIT_EXCEEDED', `补丁文本超过 ${MAX_PATCH_BYTES} 字节上限`, 413)
    }
    const parsed = parseApplyPatch(input.patch)
    if (parsed.length > MAX_AFFECTED_FILES) {
      throw new AgentError(
        'PATCH_LIMIT_EXCEEDED',
        `补丁涉及 ${parsed.length} 个文件，超过 ${MAX_AFFECTED_FILES} 个文件上限`,
        413,
      )
    }

    const prepared: PreparedOperation[] = []
    const configWrites: ConfigWrite[] = []
    const canonicalPaths = new Map<string, string>()
    let stagedBytes = 0
    let ruleRequiresApproval = false

    const registerCanonical = (canonicalPath: string, path: string) => {
      const key = canonicalKey(canonicalPath)
      const duplicate = canonicalPaths.get(key)
      if (duplicate) {
        throw new AgentError(
          'PATCH_DUPLICATE_PATH',
          `补丁中的 "${path}" 与 "${duplicate}" 指向同一个文件；每个文件只能出现一次`,
          409,
        )
      }
      canonicalPaths.set(key, path)
      return key
    }

    for (const operation of parsed) {
      const expectation = operation.type === 'add' ? 'new-file' : 'existing-file'
      const inspection = await context.workspace.inspectMutationPath(operation.path, expectation)
      const path = safeWorkspacePath(context, inspection)
      const key = registerCanonical(inspection.canonicalPath, path)

      if (operation.type === 'add') {
        const sizeBytes = Buffer.byteLength(operation.content, 'utf8')
        if (sizeBytes > MAX_FILE_BYTES) {
          throw new AgentError(
            'WORKSPACE_FILE_TOO_LARGE',
            `补丁后的 "${path}" 超过 ${MAX_FILE_BYTES} 字节上限`,
            413,
          )
        }
        stagedBytes += sizeBytes
        const stats = operationStats(operation, null)
        const protection = protectedPath(context, inspection)
        ruleRequiresApproval ||= protection.requiresApproval
        if (protection.configScope) {
          configWrites.push({ path, content: operation.content, scope: protection.configScope })
        }
        prepared.push({
          operation: 'create',
          requestedPath: operation.path,
          path,
          workspacePath: inspection.path,
          canonicalPath: inspection.canonicalPath,
          content: operation.content,
          beforeContent: null,
          ...stats,
        })
        continue
      }

      if (inspection.expectation !== 'existing-file') {
        throw new AgentError(
          'WORKSPACE_PATH_NOT_FOUND',
          `${operation.type === 'delete' ? 'Delete File' : 'Update File'} 目标 "${path}" 不存在`,
          404,
        )
      }
      const sourceProtection = protectedPath(context, inspection)
      if (operation.type === 'delete') {
        if (sourceProtection.configScope) configMutationError(path)
        ruleRequiresApproval ||= sourceProtection.requiresApproval
        const expectedRevision = await requireSnapshot(context, operation.path, path, inspection)
        prepared.push({
          operation: 'delete',
          requestedPath: operation.path,
          path,
          workspacePath: inspection.path,
          canonicalPath: inspection.canonicalPath,
          content: '',
          beforeContent: inspection.content,
          expectedRevision,
          ...operationStats(operation, inspection.content),
        })
        continue
      }

      // Update File: an optional Move to turns this into a create-target plus
      // delete-source pair; otherwise it stays a single in-place update.
      const expectedRevision = await requireSnapshot(context, operation.path, path, inspection)
      const content =
        operation.chunks.length > 0
          ? applyPatchText(path, operation.chunks, inspection.content).content
          : inspection.content
      const sizeBytes = Buffer.byteLength(content, 'utf8')
      if (sizeBytes > MAX_FILE_BYTES) {
        throw new AgentError(
          'WORKSPACE_FILE_TOO_LARGE',
          `补丁后的 "${path}" 超过 ${MAX_FILE_BYTES} 字节上限`,
          413,
        )
      }

      if (!operation.moveTo) {
        ruleRequiresApproval ||= sourceProtection.requiresApproval
        if (sourceProtection.configScope) {
          configWrites.push({ path, content, scope: sourceProtection.configScope })
        }
        stagedBytes += sizeBytes
        prepared.push({
          operation: 'update',
          requestedPath: operation.path,
          path,
          workspacePath: inspection.path,
          canonicalPath: inspection.canonicalPath,
          content,
          beforeContent: inspection.content,
          expectedRevision,
          ...chunkStats(operation.chunks),
        })
        continue
      }

      if (sourceProtection.configScope) configMutationError(path)
      const targetInspection = await context.workspace.inspectMutationPath(
        operation.moveTo,
        'new-file',
      )
      const targetPath = safeWorkspacePath(context, targetInspection)
      const targetProtection = protectedPath(context, targetInspection)
      if (targetProtection.configScope) configMutationError(targetPath)
      if (canonicalKey(targetInspection.canonicalPath) === key) {
        throw new AgentError(
          'PATCH_MOVE_INVALID',
          `Move to 目标 "${targetPath}" 与源文件 "${path}" 是同一个文件；源和目标必须是不同文件。本次补丁未修改任何文件`,
          400,
        )
      }
      registerCanonical(targetInspection.canonicalPath, targetPath)
      ruleRequiresApproval ||=
        sourceProtection.requiresApproval || targetProtection.requiresApproval
      stagedBytes += sizeBytes
      const stats = chunkStats(operation.chunks)
      const movedContent = withSourceBom(content, inspection.utf8Bom)
      prepared.push({
        operation: 'create',
        requestedPath: operation.moveTo,
        path: targetPath,
        workspacePath: targetInspection.path,
        canonicalPath: targetInspection.canonicalPath,
        content: movedContent,
        beforeContent: null,
        // The reviewer sees the move target as a full-file addition and the
        // source as a full-file deletion, so the summary matches those diffs.
        additions: countContentLines(movedContent),
        deletions: 0,
        hunkCount: stats.hunkCount,
        movedFrom: path,
      })
      prepared.push({
        operation: 'delete',
        requestedPath: operation.path,
        path,
        workspacePath: inspection.path,
        canonicalPath: inspection.canonicalPath,
        content: '',
        beforeContent: inspection.content,
        expectedRevision,
        additions: 0,
        deletions: countContentLines(inspection.content),
        hunkCount: 0,
        movedTo: targetPath,
      })
    }

    if (stagedBytes > MAX_STAGED_BYTES) {
      throw new AgentError(
        'PATCH_LIMIT_EXCEEDED',
        `补丁暂存内容超过 ${MAX_STAGED_BYTES} 字节上限`,
        413,
      )
    }
    if (prepared.length > MAX_AFFECTED_FILES) {
      throw new AgentError(
        'PATCH_LIMIT_EXCEEDED',
        `补丁涉及 ${prepared.length} 个文件变更，超过 ${MAX_AFFECTED_FILES} 个文件上限`,
        413,
      )
    }

    const reviewSummary = summarize(prepared)
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          parsed,
          canonicalPaths: prepared.map((operation) => canonicalKey(operation.canonicalPath)),
        }),
        'utf8',
      )
      .digest('hex')
    return {
      operations: prepared,
      authorizationScope: {
        affectedPaths: prepared.map(({ operation, path }): ToolAffectedPath => ({
          operation,
          path,
        })),
        fingerprint,
        ruleRequiresApproval,
        reviewSummary,
      },
      configWrites,
    }
  } catch (cause) {
    return preflightError(cause)
  }
}

const safePartialCommit = (cause: AgentError, prepared: PreparedPatch) => {
  const details =
    cause.details && typeof cause.details === 'object'
      ? (cause.details as { committed?: unknown; pending?: unknown })
      : {}
  const byWorkspacePath = new Map(
    prepared.operations.map((operation) => [canonicalKey(operation.workspacePath), operation.path]),
  )
  const safeList = (value: unknown) =>
    Array.isArray(value)
      ? value
          .filter((path): path is string => typeof path === 'string')
          .map((path) => byWorkspacePath.get(canonicalKey(path)) ?? '<workspace-file>')
      : []
  const committed = safeList(details.committed)
  const pending = safeList(details.pending)
  const list = (paths: readonly string[]) => (paths.length ? paths.slice(0, 10).join('、') : '无')
  // A move is created then deleted; a failure between the two leaves both endpoints
  // on disk, so name them explicitly instead of leaving it to the user to infer.
  const movedPartially = prepared.operations
    .filter((operation) => operation.movedFrom)
    .filter((target) => {
      const source = prepared.operations.find((operation) => operation.movedTo === target.path)
      if (!source) return false
      return committed.includes(target.path) !== committed.includes(source.path)
    })
    .map((target) => `${target.movedFrom} -> ${target.path}`)
  return new AgentError(
    'PATCH_PARTIAL_COMMIT',
    `补丁提交阶段失败。已提交：${list(committed)}；未提交：${list(pending)}${
      movedPartially.length
        ? `。移动两端状态不一致（两端可能同时存在）：${list(movedPartially)}`
        : ''
    }。请重新 Read 所有受影响文件，禁止直接重放原补丁`,
    500,
    { committed, pending, ...(movedPartially.length ? { movedPartially } : {}) },
  )
}

const invalidateSnapshots = async (
  context: ToolContext,
  operations: readonly PreparedOperation[],
) => {
  if (!context.fileSnapshots) return
  for (const operation of operations) {
    try {
      await context.fileSnapshots.invalidate([operation.requestedPath])
    } catch {
      // Snapshot cleanup is best-effort and must never replace the original patch failure.
    }
  }
}

export const applyPatchDefinition: ToolDefinition<ApplyPatchInput, ApplyPatchOutput> = {
  sdkName: 'apply_patch',
  name: 'workspace.apply_patch',
  description: [
    'Apply a deterministic multi-file patch to add, update, delete or move UTF-8 files in the workspace. Prefer Edit for ordinary single-file changes. Read the source of every Update, Delete and Move operation first.',
    'With full access, patches may target outside-workspace absolute paths subject to host policy.',
    'Start with *** Begin Patch and end with *** End Patch. Supports *** Add File: path, *** Update File: path, *** Delete File: path, *** Move to: newpath (immediately after Update File), multiple @@ hunks and *** End of File.',
    'Use @@ or @@ <exact context> hunk headers without line counts; do not generate @@ -old,+new @@ headers.',
    'Context must match exactly and uniquely. LF/CRLF are equivalent; whitespace, indentation and Unicode are not fuzzy-matched.',
    'Prefix every Add File content line with +. A bare *** Move to with no hunks is a pure move. Deleting or moving Pidex config files is rejected.',
  ].join('\n'),
  schema: applyPatchInputSchema,
  inputSchema: {
    type: 'object',
    properties: {
      patch: {
        type: 'string',
        description: [
          'Complete raw patch. Start directly with *** Begin Patch and end with *** End Patch. Do not use Markdown code fences.',
          'Minimal example:\n*** Begin Patch\n*** Add File: path/to/file.txt\n+content\n*** End Patch',
          'Update example:\n*** Begin Patch\n*** Update File: path/to/file.txt\n@@\n-old\n+new\n*** End Patch',
          'Move example:\n*** Begin Patch\n*** Update File: from.txt\n*** Move to: to.txt\n*** End Patch',
          'Delete example:\n*** Begin Patch\n*** Delete File: path/to/file.txt\n*** End Patch',
          'Update, Delete and Move must use the complete original just read. After parse or context failure, Read again and rebuild; do not replay unchanged.',
        ].join('\n'),
        minLength: 1,
        maxLength: MAX_PATCH_BYTES,
      },
    },
    required: ['patch'],
    additionalProperties: false,
  },
  constrainedSampling: {
    type: 'grammar',
    variants: {
      openai_lark: APPLY_PATCH_LARK_GRAMMAR,
    },
  },
  capabilities: {
    filesystem: 'workspace-write',
    network: 'none',
    process: false,
    externalState: true,
    userInteraction: false,
  },
  allowedModes: ['chat'],
  allowedProfiles: ['main', 'default', 'worker'],
  approvalStrategy: 'policy',
  visibility: 'deferred',
  executionMode: 'sequential',
  inspectInput: async (input, context) => {
    const prepared = await preparePatch(input, context)
    const protectedFile = (file: PreparedOperation) =>
      filePathProtection(file.canonicalPath, file.path).requiresApproval
    return {
      authorizationScope: prepared.authorizationScope,
      fileDiffs: prepared.operations
        .filter((file) => !protectedFile(file))
        .map((file) =>
          buildFileDiff({
            path: file.path,
            operation: file.operation,
            beforeContent: file.beforeContent,
            afterContent: file.operation === 'delete' ? null : withoutBom(file.content),
          }),
        ),
      ...(prepared.configWrites.length ? { configWrites: prepared.configWrites } : {}),
    }
  },
  progress: () => ({ message: '正在应用工作区补丁' }),
  execute: async (input, context) => {
    const prepared = await preparePatch(input, context)
    if (
      context.authorizationScope &&
      context.authorizationScope.fingerprint !== prepared.authorizationScope.fingerprint
    ) {
      throw new AgentError(
        'APPROVAL_SCOPE_CHANGED',
        'apply_patch 的文件范围或内容在授权后发生变化，已拒绝执行。请重新 Read 并重新提交补丁；本次补丁未修改任何文件',
        409,
      )
    }

    const mutations: EditorMutation[] = prepared.operations.map((operation) => {
      if (operation.operation === 'create') {
        return {
          operation: 'create',
          path: operation.requestedPath,
          content: operation.content,
        }
      }
      if (operation.operation === 'delete') {
        return {
          operation: 'delete',
          path: operation.requestedPath,
          expectedRevision: operation.expectedRevision!,
        }
      }
      return {
        operation: 'update',
        path: operation.requestedPath,
        content: operation.content,
        expectedRevision: operation.expectedRevision!,
      }
    })

    let committed = false
    try {
      const result = await context.workspace.commitEditorMutations(mutations)
      committed = true
      const resultByPath = new Map(result.files.map((file) => [canonicalKey(file.path), file]))
      const files = prepared.operations.map((operation) => {
        const saved = resultByPath.get(canonicalKey(operation.workspacePath))
        const afterSha256 = saved?.afterSha256 ?? null
        const revision = saved?.revision ?? null
        if (!saved || (operation.operation === 'delete' ? revision !== null : !afterSha256)) {
          throw new AgentError(
            'PATCH_PARTIAL_COMMIT',
            '补丁写入结果不完整。请重新 Read 所有受影响文件后再继续',
            500,
          )
        }
        return {
          operation: operation.operation,
          path: operation.path,
          additions: operation.additions,
          deletions: operation.deletions,
          beforeSha256: saved.beforeSha256,
          afterSha256,
          revision,
          ...(operation.movedFrom ? { movedFrom: operation.movedFrom } : {}),
          ...(operation.movedTo ? { movedTo: operation.movedTo } : {}),
        }
      })
      const evidence = prepared.operations.map((operation, index) => {
        const file = files[index]!
        return {
          operation: operation.operation,
          path: operation.path,
          beforeContent: operation.beforeContent,
          afterContent: operation.operation === 'delete' ? null : withoutBom(operation.content),
          beforeSha256: file.beforeSha256,
          afterSha256: file.afterSha256,
        }
      })
      await context.recordMutation?.(evidence).catch(() => undefined)
      for (let index = 0; index < prepared.operations.length; index += 1) {
        const operation = prepared.operations[index]!
        if (operation.operation === 'delete') {
          // Deleted files have no content to mirror to the editor and no snapshot
          // revision; drop the Read snapshot so a later edit cannot reuse it.
          await context.fileSnapshots?.invalidate([operation.requestedPath])
          continue
        }
        await context.fileSaved?.({
          filePath: operation.workspacePath,
          content: operation.content,
        })
        await context.fileSnapshots?.set(operation.requestedPath, files[index]!.revision!)
      }
      return {
        operation: 'apply_patch',
        files,
        summary: prepared.authorizationScope.reviewSummary!,
      }
    } catch (cause) {
      await invalidateSnapshots(context, prepared.operations)
      if (committed) {
        const paths = prepared.operations.map((operation) => operation.path)
        throw new AgentError(
          'PATCH_PARTIAL_COMMIT',
          `补丁文件已经写入，但后续状态同步失败。请重新 Read：${paths.slice(0, 10).join('、')}`,
          500,
          { committed: paths, pending: [] },
        )
      }
      if (cause instanceof AgentError && cause.code === 'PATCH_PARTIAL_COMMIT') {
        throw safePartialCommit(cause, prepared)
      }
      if (cause instanceof AgentError && cause.code !== 'WORKSPACE_WRITE_FAILED') {
        return preflightError(cause)
      }
      throw new AgentError(
        'PATCH_EXECUTION_FAILED',
        'apply_patch 暂存或提交失败。请检查目标是否可写并重新 Read 后再试；本次补丁未修改任何文件',
        500,
      )
    }
  },
  formatResult: (output) => {
    const moved = output.files.filter((file) => file.movedFrom).length
    const created = output.files.filter(
      (file) => file.operation === 'create' && !file.movedFrom,
    ).length
    const updated = output.files.filter((file) => file.operation === 'update').length
    const deleted = output.files.filter(
      (file) => file.operation === 'delete' && !file.movedTo,
    ).length
    return {
      content: `补丁已应用：新增 ${created} 个文件，更新 ${updated} 个文件，删除 ${deleted} 个文件，移动 ${moved} 个文件（+${output.summary.additions} -${output.summary.deletions}）`,
      details: output,
    }
  },
}
