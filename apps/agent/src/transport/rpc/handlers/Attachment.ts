import {
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  type RpcMethod,
  type RpcParams,
} from '@pidex/agent-protocol'
import { AgentError, attachmentView, enumValue, stringParam } from '../RpcRouter'
import { optionalRpcRecord, rpcRecord } from '../Decoders'
import type { RpcHandlerGroup } from './Types'

export const attachmentHandlers = {
  name: 'attachment',
  methods: [
    'attachment/import',
    'attachment/read',
    'attachment/upload/begin',
    'attachment/upload/chunk',
    'attachment/upload/commit',
    'attachment/upload/abort',
  ],
  async handle(runtime, method: RpcMethod, rawParams, context) {
    const { attachments } = runtime.dependencies
    const owner = runtime.requireConnection(context)
    switch (method) {
      case 'attachment/import': {
        const params = optionalRpcRecord(rawParams)
        if (!Array.isArray(params.uploads))
          throw new AgentError('ATTACHMENT_FORMAT_INVALID', 'uploads 参数无效', 400)
        const uploads = params.uploads.map((entry) => {
          const value = rpcRecord(entry, 'attachment')
          const kind = enumValue(value.kind, ['text', 'image', 'audio', 'video'] as const, 'kind')
          const data = stringParam(value, 'data')
          return {
            kind,
            name: stringParam(value, 'name'),
            mimeType: stringParam(value, 'mediaType', 'mimeType'),
            data:
              kind !== 'text' || value.encoding === 'base64'
                ? new Uint8Array(Buffer.from(data, 'base64'))
                : data,
          }
        })
        return { attachments: (await attachments.store(uploads)).map(attachmentView) }
      }
      case 'attachment/upload/begin':
        return runtime.attachmentUploads.begin(
          owner,
          rawParams as RpcParams<'attachment/upload/begin'>,
        )
      case 'attachment/upload/chunk':
        return runtime.attachmentUploads.chunk(
          owner,
          rawParams as RpcParams<'attachment/upload/chunk'>,
        )
      case 'attachment/upload/commit': {
        const { uploadId } = rawParams as RpcParams<'attachment/upload/commit'>
        return {
          attachment: attachmentView(await runtime.attachmentUploads.commit(owner, uploadId)),
        }
      }
      case 'attachment/upload/abort': {
        const { uploadId } = rawParams as RpcParams<'attachment/upload/abort'>
        return runtime.attachmentUploads.abort(owner, uploadId)
      }
      case 'attachment/read': {
        const { attachmentId, range } = rawParams as RpcParams<'attachment/read'>
        const [record] = await attachments.getMany([attachmentId])
        if (!record) throw new AgentError('ATTACHMENT_NOT_FOUND', '附件不存在', 404)
        if (
          record.kind === 'pdf' &&
          !runtime.connectionHasCapability(context, 'attachments.chunked.v1')
        ) {
          throw new AgentError('ATTACHMENT_NOT_FOUND', '附件不存在', 404)
        }
        if (record.kind === 'pdf' && !range && record.size > ATTACHMENT_UPLOAD_CHUNK_BYTES) {
          throw new AgentError('ATTACHMENT_LIMIT', '请按范围读取 PDF 附件', 413)
        }
        const normalizedRange =
          range && record.kind === 'pdf'
            ? {
                offset: range.offset,
                length: Math.min(range.length, ATTACHMENT_UPLOAD_CHUNK_BYTES),
              }
            : range
        const { data } = await attachments.read(attachmentId, normalizedRange)
        return {
          attachment: attachmentView(record),
          data:
            record.kind === 'text'
              ? new TextDecoder().decode(data)
              : Buffer.from(data).toString('base64'),
          encoding: record.kind === 'text' ? 'utf8' : 'base64',
          range: { offset: range?.offset ?? 0, length: data.byteLength, total: record.size },
        }
      }
      default:
        throw new Error(`Unknown attachment RPC method: ${method}`)
    }
  },
} as const satisfies RpcHandlerGroup
