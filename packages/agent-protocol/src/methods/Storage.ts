import { Schema } from 'effect'
import { defineMethod, type MethodMap } from '../wire/Definition'
import { TimestampSchema } from '../wire/Primitives'

const NonNegativeFiniteSchema = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
)

const NonNegativeIntSchema = Schema.Int.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
)

export const StorageSummaryParamsSchema = Schema.Struct({})

export const StorageBreakdownSchema = Schema.Struct({
  chatBytes: NonNegativeFiniteSchema,
  worktreeBytes: NonNegativeFiniteSchema,
  artifactsBytes: NonNegativeFiniteSchema,
  otherBytes: NonNegativeFiniteSchema,
})

export const StorageChatDetailsSchema = Schema.Struct({
  messagesBytes: NonNegativeFiniteSchema,
  attachmentsBytes: NonNegativeFiniteSchema,
  archivedBytes: NonNegativeFiniteSchema,
  sqliteOverheadBytes: NonNegativeFiniteSchema,
})

export const StorageFoldersSchema = Schema.Struct({
  dataDirBytes: NonNegativeFiniteSchema,
  customWorktreeRootBytes: Schema.NullOr(NonNegativeFiniteSchema),
})

export const StorageSummaryResultSchema = Schema.Struct({
  dataDir: Schema.String,
  defaultWorktreeRoot: Schema.String,
  configuredWorktreeRoot: Schema.NullOr(Schema.String),
  breakdown: StorageBreakdownSchema,
  chatDetails: StorageChatDetailsSchema,
  folders: StorageFoldersSchema,
  computedAt: TimestampSchema,
})

export const OldChatsScopeSchema = Schema.Literals(['archived', 'all', 'unarchived'])

export const StorageOldChatsListParamsSchema = Schema.Struct({
  olderThanDays: Schema.NullOr(NonNegativeIntSchema),
  scope: OldChatsScopeSchema,
  limit: Schema.optional(NonNegativeIntSchema),
  offset: Schema.optional(NonNegativeIntSchema),
})

export const OldChatStorageItemSchema = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  updatedAt: TimestampSchema,
  archivedAt: Schema.NullOr(TimestampSchema),
  estimatedBytes: NonNegativeFiniteSchema,
  subagentCount: NonNegativeIntSchema,
  subagentBytes: NonNegativeFiniteSchema,
})

export const StorageOldChatsListResultSchema = Schema.Struct({
  items: Schema.Array(OldChatStorageItemSchema),
  totalCount: NonNegativeIntSchema,
  totalSubagentCount: NonNegativeIntSchema,
  hasMore: Schema.Boolean,
})

export const StorageOldChatsDeleteParamsSchema = Schema.Struct({
  threadIds: Schema.Array(Schema.String),
})

export const StorageOldChatsDeleteFailureSchema = Schema.Struct({
  threadId: Schema.String,
  reason: Schema.String,
})

export const StorageOldChatsDeleteResultSchema = Schema.Struct({
  deletedIds: Schema.Array(Schema.String),
  failed: Schema.Array(StorageOldChatsDeleteFailureSchema),
  reclaimedBytes: NonNegativeFiniteSchema,
  vacuumed: Schema.Boolean,
})

export const DownloadedResourceCategorySchema = Schema.Literals(['speech', 'tooling'])

export const DownloadedResourceItemSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  category: DownloadedResourceCategorySchema,
  description: Schema.String,
  path: Schema.String,
  sizeBytes: NonNegativeFiniteSchema,
})

export const StorageResourcesListParamsSchema = Schema.Struct({})

export const StorageResourcesListResultSchema = Schema.Struct({
  items: Schema.Array(DownloadedResourceItemSchema),
})

export const StorageResourcesDeleteParamsSchema = Schema.Struct({
  resourceId: Schema.String,
})

export const StorageResourcesDeleteResultSchema = Schema.Struct({
  resourceId: Schema.String,
  reclaimedBytes: NonNegativeFiniteSchema,
})

export const StorageRpcMethods = {
  'storage/summary': defineMethod({
    params: StorageSummaryParamsSchema,
    result: StorageSummaryResultSchema,
    errors: [] as const,
    capability: null,
    mutation: false,
  }),
  'storage/oldChats/list': defineMethod({
    params: StorageOldChatsListParamsSchema,
    result: StorageOldChatsListResultSchema,
    errors: [] as const,
    capability: null,
    mutation: false,
  }),
  'storage/oldChats/delete': defineMethod({
    params: StorageOldChatsDeleteParamsSchema,
    result: StorageOldChatsDeleteResultSchema,
    errors: [] as const,
    capability: null,
    mutation: true,
  }),
  'storage/resources/list': defineMethod({
    params: StorageResourcesListParamsSchema,
    result: StorageResourcesListResultSchema,
    errors: [] as const,
    capability: null,
    mutation: false,
  }),
  'storage/resources/delete': defineMethod({
    params: StorageResourcesDeleteParamsSchema,
    result: StorageResourcesDeleteResultSchema,
    errors: ['INVALID_REQUEST', 'CONFLICT'] as const,
    capability: null,
    mutation: true,
  }),
} as const satisfies MethodMap

export type StorageSummaryResult = typeof StorageSummaryResultSchema.Type
export type OldChatsScope = typeof OldChatsScopeSchema.Type
export type OldChatStorageItem = typeof OldChatStorageItemSchema.Type
export type StorageOldChatsListResult = typeof StorageOldChatsListResultSchema.Type
export type StorageOldChatsDeleteResult = typeof StorageOldChatsDeleteResultSchema.Type
export type DownloadedResourceItem = typeof DownloadedResourceItemSchema.Type
export type StorageResourcesListResult = typeof StorageResourcesListResultSchema.Type
export type StorageResourcesDeleteResult = typeof StorageResourcesDeleteResultSchema.Type
