import type { Api, Context, Model } from '@earendil-works/pi-ai'
import type { Model as PidexModel } from '@pidex/model-schema'
import { isQwenCompatibleEndpoint } from './PiProviderApis'

const MiB = 1024 * 1024
export const BEDROCK_PDF_COUNT_LIMIT = 5

export function mediaRequestBudget(model: Pick<Model<Api>, 'api'>) {
  if (model.api === 'google-generative-ai') return 19_000_000
  if (model.api === 'bedrock-converse-stream') return 24_000_000
  return (model.api === 'anthropic-messages' ? 30 : 40) * MiB
}

export const encodedMediaSize = (sizeBytes: number) => 4 * Math.ceil(sizeBytes / 3)

export type MediaInputCapability = PidexModel.MediaInputCapability

export type MediaAttachment = {
  kind: 'pdf' | 'video'
  id: string
  inputId: string
  name: string
  mediaType: string
  sizeBytes: number
}

export type MediaAttachmentReference = {
  kind: 'pdf' | 'video'
  attachmentId: string
  inputId: string
  name: string
  mimeType: string
  sizeBytes: number
}

export type ReadMediaAttachment = (
  reference: MediaAttachmentReference,
) => Promise<Uint8Array | undefined>

export type InlineMediaInput = { kind: 'audio' | 'video'; mimeType: string; data: string }

export type MediaInput = InlineMediaInput | MediaAttachmentReference

export type RuntimeAttachment =
  | { kind: 'text'; name: string; text: string }
  | { kind: 'image' | 'audio' | 'video'; name: string; mediaType: string; base64: string }
  | MediaAttachment

export function runtimeAttachmentMedia(attachment: RuntimeAttachment): MediaInput[] {
  if (attachment.kind === 'text' || attachment.kind === 'image') return []
  return 'base64' in attachment
    ? [{ kind: attachment.kind, mimeType: attachment.mediaType, data: attachment.base64 }]
    : [
        {
          kind: attachment.kind,
          attachmentId: attachment.id,
          inputId: attachment.inputId,
          name: attachment.name,
          mimeType: attachment.mediaType,
          sizeBytes: attachment.sizeBytes,
        },
      ]
}

type MediaModel = Model<Api> & {
  catalog?: { input?: readonly string[] }
  mediaInput?: MediaInputCapability
  inputExplicit?: boolean
}

const gemini = (model: Model<Api>) =>
  model.api === 'google-generative-ai' || model.api === 'google-vertex'

const glmCompletions = (api: Api, url: URL | undefined) =>
  api === 'openai-completions' &&
  url?.protocol === 'https:' &&
  (url.hostname === 'open.bigmodel.cn' || url.hostname === 'api.z.ai') &&
  /^\/api(?:\/coding)?\/paas\/v4\/?$/.test(url.pathname)

export const pdfRequiresSeparateMessage = (model: Pick<Model<Api>, 'api' | 'baseUrl'>) =>
  URL.canParse(model.baseUrl) && glmCompletions(model.api, new URL(model.baseUrl))

export const mediaFileBudget = (
  model: Pick<Model<Api>, 'api' | 'baseUrl'>,
  kind: MediaInput['kind'],
) => {
  if (kind === 'pdf' && model.api === 'bedrock-converse-stream') return 6_000_000
  if (
    kind === 'video' &&
    URL.canParse(model.baseUrl) &&
    isQwenCompatibleEndpoint(new URL(model.baseUrl))
  )
    return 9_999_900
  return Infinity
}

export function nativeMediaFormat(
  model: MediaModel,
  kind: MediaInput['kind'],
  mimeType: string,
): 'gemini' | 'audio' | 'anthropic' | 'responses' | 'completions' | 'bedrock' | undefined {
  const declared = (model.input as readonly string[]).includes(kind)
  const url = URL.canParse(model.baseUrl) ? new URL(model.baseUrl) : undefined
  const baseUrl = url?.href.replace(/\/$/, '')
  const host = url?.hostname
  const https = url?.protocol === 'https:'
  const qwen = isQwenCompatibleEndpoint(url)
  const qwenChat =
    qwen &&
    ((model.api === 'openai-completions' && url?.pathname.startsWith('/compatible-mode/')) ||
      (model.api === 'anthropic-messages' && url?.pathname.startsWith('/apps/anthropic')))
  const kimiChat =
    https &&
    model.api === 'openai-completions' &&
    (host === 'api.moonshot.ai' || host === 'api.moonshot.cn') &&
    /^\/v1\/?$/.test(url.pathname) &&
    /^kimi-k3(?:\.1-pro)?$/i.test(model.id)
  const openRouter = https && host === 'openrouter.ai' && /^\/api\/v1\/?$/.test(url.pathname)
  const bedrock =
    https &&
    model.api === 'bedrock-converse-stream' &&
    /^bedrock-runtime(?:-fips)?\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(host ?? '')
  const nova =
    bedrock && /^(?:[a-z]+\.)?amazon\.nova-(?:(?:lite|pro|premier)|2-lite)-v1:0$/.test(model.id)
  const configured =
    model.mediaInput &&
    model.mediaInput.endpoint === baseUrl &&
    model.mediaInput.protocol === model.api
      ? model.mediaInput
      : undefined
  if (kind === 'audio') {
    if (!declared) return undefined
    if (gemini(model)) return 'gemini'
    if (
      model.api === 'openai-completions' &&
      ['audio/wav', 'audio/mpeg', 'audio/mp3'].includes(mimeType)
    )
      return 'audio'
    return undefined
  }
  if (kind === 'video') {
    if (gemini(model) && (declared || (!model.inputExplicit && model.id.includes('gemini'))))
      return 'gemini'
    if (host === 'api.anthropic.com' || host === 'api.openai.com') return undefined
    const supportedContainer = mimeType === 'video/mp4' || mimeType === 'video/webm'
    if (bedrock && supportedContainer && (declared || (nova && !model.inputExplicit)))
      return 'bedrock'
    if (!declared) return undefined
    const compatibleVideo = configured?.video
      ? configured.video.some((format) => format === mimeType)
      : (qwenChat && /^qwen/i.test(model.id) && mimeType === 'video/mp4') ||
        (kimiChat && supportedContainer) ||
        (openRouter && supportedContainer)
    if (!compatibleVideo) return undefined
    if (model.api === 'anthropic-messages' && !openRouter) return 'anthropic'
    if (model.api === 'openai-completions') return 'completions'
    if (model.api === 'openai-responses' && !qwen) return 'responses'
    return undefined
  }
  if (mimeType !== 'application/pdf' || configured?.pdf === false) return undefined
  const catalogPdf = model.catalog?.input?.includes('pdf') ?? declared
  if (catalogPdf && gemini(model)) return 'gemini'
  if (bedrock && (catalogPdf || nova)) return 'bedrock'
  const qwenPdf =
    qwenChat &&
    /^qwen(?:4-max|3\.8-(?:max|flash|27b))(?:-|$)/i.test(model.id) &&
    (!/^qwen3\.8-27b(?:-|$)/i.test(model.id) ||
      (model.api === 'openai-completions' &&
        (host === 'dashscope.aliyuncs.com' ||
          host === 'maas.qianwenaiapi.com' ||
          /(?:^|\.)cn-beijing\.maas\.(?:aliyuncs|qwencloudapi)\.com$/.test(host ?? ''))))
  const glmPdf = glmCompletions(model.api, url) && /^glm-(?:5v-turbo|5\.3-flashx?)$/i.test(model.id)
  const responses = model.api === 'openai-responses' || model.api === 'azure-openai-responses'
  const azure = https && /\.(?:openai|cognitiveservices)\.azure\.com$/.test(host ?? '')
  if (!(
    configured?.pdf ||
    qwenPdf ||
    glmPdf ||
    (catalogPdf &&
      ((https && host === 'api.anthropic.com' && model.api === 'anthropic-messages') ||
        (https && host === 'api.openai.com' && (responses || model.api === 'openai-completions')) ||
        (openRouter && (responses || model.api === 'openai-completions')) ||
        (azure && responses)))
  ))
    return undefined
  if (model.api === 'anthropic-messages') return 'anthropic'
  if (responses) return 'responses'
  if (model.api === 'openai-completions') return 'completions'
  return undefined
}

function payloadBlock(
  format: NonNullable<ReturnType<typeof nativeMediaFormat>>,
  part: MediaInput,
  data: string,
): Record<string, unknown> {
  if (format === 'gemini') return { inlineData: { mimeType: part.mimeType, data } }
  if (format === 'audio')
    return {
      type: 'input_audio',
      input_audio: { data, format: part.mimeType === 'audio/wav' ? 'wav' : 'mp3' },
    }
  if (format === 'anthropic')
    return {
      type: part.kind === 'pdf' ? 'document' : 'video',
      source: { type: 'base64', media_type: part.mimeType, data },
    }
  if (format === 'bedrock') {
    const source = { bytes: Buffer.from(data, 'base64') }
    return part.kind === 'pdf'
      ? { document: { format: 'pdf', name: 'Document', source } }
      : { video: { format: part.mimeType === 'video/webm' ? 'webm' : 'mp4', source } }
  }
  const fileData = `data:${part.mimeType};base64,${data}`
  if (part.kind === 'video')
    return format === 'responses'
      ? { type: 'input_video', video_url: fileData }
      : { type: 'video_url', video_url: { url: fileData } }
  const filename = 'name' in part ? part.name : 'attachment.pdf'
  if (format === 'responses') return { type: 'input_file', filename, file_data: fileData }
  return { type: 'file', file: { filename, file_data: fileData } }
}

type PayloadObject = Record<string, unknown>

function object(value: unknown): PayloadObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as PayloadObject)
    : undefined
}

/** Prepare the media projection once per model step and apply it only to user content. */
export async function prepareMediaInput(
  model: Model<Api>,
  context: Context,
  options: { currentInputIds?: ReadonlySet<string>; readAttachment?: ReadMediaAttachment } = {},
) {
  const replacements = new Map<string, PayloadObject>()
  const isManaged = (part: MediaInput): part is MediaAttachmentReference => 'attachmentId' in part
  type ProjectedMedia = {
    part: MediaInput
    format?: NonNullable<ReturnType<typeof nativeMediaFormat>>
    omitted?: 'model' | 'protocol' | 'budget' | 'mixed'
  }
  const mediaByMessage = context.messages.map((message): ProjectedMedia[] => {
    if (message.role !== 'user') return []
    const { media = [], mediaAttachments = [] } = message as typeof message & {
      media?: InlineMediaInput[]
      mediaAttachments?: MediaAttachmentReference[]
    }
    return [...media, ...mediaAttachments].map((part) => ({ part }))
  })
  let lastAssistant = context.messages.length - 1
  while (lastAssistant >= 0 && context.messages[lastAssistant]?.role !== 'assistant')
    lastAssistant--
  const isCurrent = (part: MediaInput, index: number) =>
    isManaged(part) ? (options.currentInputIds?.has(part.inputId) ?? false) : index > lastAssistant
  let remaining = mediaRequestBudget(model)
  const separatePdf = pdfRequiresSeparateMessage(model)
  const bedrockPdfCounts = new Map<number, number>()
  const select = (projection: ProjectedMedia, current: boolean, index: number) => {
    const { part } = projection
    const format = nativeMediaFormat(model, part.kind, part.mimeType)
    if (!format) {
      const supportedByModel = (model.input as readonly string[]).includes(part.kind)
      if (current) {
        if (!isManaged(part) && !supportedByModel)
          throw new Error(`当前模型不支持${part.kind === 'audio' ? '音频' : '视频'}输入`)
        throw new Error('当前协议不支持该媒体输入，请切换到兼容的聊天端点')
      }
      projection.omitted = supportedByModel ? 'protocol' : 'model'
      return
    }
    if (separatePdf && part.kind === 'pdf') {
      const message = context.messages[index]
      const hasImage =
        message?.role === 'user' &&
        Array.isArray(message.content) &&
        message.content.some(({ type }) => type === 'image')
      const hasVideo = mediaByMessage[index]?.some(
        ({ part }) => part.kind === 'video' && nativeMediaFormat(model, 'video', part.mimeType),
      )
      if (hasImage || hasVideo) {
        if (current) throw new Error('当前智谱端点的 PDF 需要与图片或视频分开发送')
        projection.omitted = 'mixed'
        return
      }
    }
    const size = isManaged(part) ? encodedMediaSize(part.sizeBytes) : part.data.length
    const pdfCount = bedrockPdfCounts.get(index) ?? 0
    const bedrockPdf = format === 'bedrock' && part.kind === 'pdf'
    if (
      (part.kind !== 'audio' && size > Math.min(remaining, mediaFileBudget(model, part.kind))) ||
      (bedrockPdf && pdfCount >= BEDROCK_PDF_COUNT_LIMIT)
    ) {
      if (current)
        throw new Error(
          `附件${isManaged(part) ? `「${part.name}」` : ''}无法发送，超出本次请求的媒体容量`,
        )
      projection.omitted = 'budget'
      return
    }
    projection.format = format
    if (bedrockPdf) bedrockPdfCounts.set(index, pdfCount + 1)
    if (part.kind !== 'audio') remaining -= size
  }
  for (const [index, media] of mediaByMessage.entries())
    for (const entry of media) if (isCurrent(entry.part, index)) select(entry, true, index)
  for (let index = mediaByMessage.length - 1; index >= 0; index--)
    for (const entry of mediaByMessage[index] ?? [])
      if (!isCurrent(entry.part, index)) select(entry, false, index)

  const messages = [...context.messages]
  for (const [index, message] of messages.entries()) {
    const media = mediaByMessage[index]
    if (message.role !== 'user' || !media?.length) continue
    const content =
      typeof message.content === 'string'
        ? [{ type: 'text' as const, text: message.content }]
        : [...message.content]
    let omittedLegacy: MediaInput['kind'] | undefined
    for (const { part, format, omitted } of media) {
      if (format) {
        const bytes = isManaged(part) ? await options.readAttachment?.(part) : undefined
        const data = isManaged(part) ? bytes && Buffer.from(bytes).toString('base64') : part.data
        if (data !== undefined) {
          const marker = `pidex-media:${crypto.randomUUID()}`
          replacements.set(marker, payloadBlock(format, part, data))
          content.push({ type: 'text', text: marker })
          omittedLegacy = undefined
          continue
        }
        if (isCurrent(part, index))
          throw new Error(`附件${isManaged(part) ? `「${part.name}」` : ''}内容不可用`)
      }
      if (!isManaged(part)) {
        if (omittedLegacy !== part.kind) {
          const cause =
            omitted === 'budget'
              ? 'request media budget exceeded'
              : `${omitted} does not support ${part.kind}`
          content.push({ type: 'text', text: `(${part.kind} omitted: ${cause})` })
        }
        omittedLegacy = part.kind
        continue
      }
      const cause =
        omitted === 'budget'
          ? '超出本次请求的媒体容量'
          : omitted === 'mixed'
            ? '当前端点的 PDF 需要与图片或视频分开发送'
            : omitted
              ? '当前模型或端点不支持此格式'
              : '附件内容不可用'
      content.push({
        type: 'text',
        text: `(附件 ${JSON.stringify(part.name)} 未传入模型，${cause})`,
      })
    }
    messages[index] = { ...message, content }
  }

  return {
    context: { ...context, messages },
    applyPayload(payload: unknown): unknown {
      if (!replacements.size) return payload
      const root = object(payload)
      const messageKey = gemini(model)
        ? 'contents'
        : model.api === 'openai-responses' || model.api === 'azure-openai-responses'
          ? 'input'
          : 'messages'
      const partKey = gemini(model) ? 'parts' : 'content'
      const source = root?.[messageKey]
      const found = new Set<string>()
      const result = Array.isArray(source)
        ? source.map((entry: unknown) => {
            const message = object(entry)
            if (message?.role !== 'user') return entry
            const parts = message[partKey]
            if (!Array.isArray(parts)) return entry
            const mapped = parts.map((part: unknown) => {
              const text = object(part)?.text
              if (typeof text !== 'string') return part
              const replacement = replacements.get(text)
              if (!replacement) return part
              found.add(text)
              return replacement
            })
            if (
              model.api === 'bedrock-converse-stream' &&
              mapped.some((part) => object(part)?.document) &&
              !mapped.some((part) => typeof object(part)?.text === 'string')
            )
              mapped.unshift({ text: '请处理所附 PDF。' })
            return { ...message, [partKey]: mapped }
          })
        : source
      if (found.size !== replacements.size)
        throw new Error('媒体内容未能映射到当前协议，请检查端点配置')
      return { ...root, [messageKey]: result }
    },
  }
}
