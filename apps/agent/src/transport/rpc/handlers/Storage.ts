import {
  StorageOldChatsDeleteParamsSchema,
  StorageOldChatsListParamsSchema,
  StorageResourcesDeleteParamsSchema,
  type RpcMethod,
} from '@pidex/agent-protocol'
import { Schema } from 'effect'
import { StorageManagementService } from '../../../storage/StorageManagementService'
import { decodeRpcParams as decodeParams } from '../Decoders'
import type { RpcRouter } from '../RpcRouter'
import type { RpcHandlerGroup } from './Types'

const decodeOldChatsList = Schema.decodeUnknownSync(StorageOldChatsListParamsSchema)
const decodeOldChatsDelete = Schema.decodeUnknownSync(StorageOldChatsDeleteParamsSchema)
const decodeResourcesDelete = Schema.decodeUnknownSync(StorageResourcesDeleteParamsSchema)

export const storageHandlers = {
  name: 'storage',
  methods: [
    'storage/summary',
    'storage/oldChats/list',
    'storage/oldChats/delete',
    'storage/resources/list',
    'storage/resources/delete',
  ],
  async handle(runtime: RpcRouter, method: RpcMethod, rawParams: unknown): Promise<unknown> {
    const { db, config, history, speech, tooling } = runtime.dependencies
    const service = new StorageManagementService(db, config, history, { speech, tooling })
    switch (method) {
      case 'storage/summary':
        return service.getSummary()
      case 'storage/oldChats/list': {
        const params = decodeParams(decodeOldChatsList, rawParams, 'storage/oldChats/list')
        return service.listOldChats(params)
      }
      case 'storage/oldChats/delete': {
        const params = decodeParams(decodeOldChatsDelete, rawParams, 'storage/oldChats/delete')
        return service.deleteOldChats(params.threadIds)
      }
      case 'storage/resources/list':
        return service.listDownloadedResources()
      case 'storage/resources/delete': {
        const params = decodeParams(decodeResourcesDelete, rawParams, 'storage/resources/delete')
        return service.deleteDownloadedResource(params.resourceId)
      }
    }
  },
} satisfies RpcHandlerGroup
