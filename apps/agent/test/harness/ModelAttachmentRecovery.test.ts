import { expect, test } from 'bun:test'
import { createModels } from '@earendil-works/pi-ai'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemorySessionRepo } from '../../scripts/support/PiSessionMemory'
import { AgentHarness } from '../../src/orchestration/harness/AgentHarness'
import { createPiCustomProvider } from '../../src/provider/pi/PiCustomProvider'
import { AttachmentService } from '../../src/subagent/AttachmentService'
import { removeFixturePath } from '../FixtureCleanup'

test('a model retry sends the same imported PDF and persists only the completed assistant response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pidex-media-recovery-'))
  const body: unknown[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      body.push(await request.json())
      const interrupted = body.length === 1
      const chunk = {
        id: 'chatcmpl-fixture',
        object: 'chat.completion.chunk',
        model: 'fixture',
        created: 0,
        choices: [
          {
            index: 0,
            delta: { content: interrupted ? 'discard this partial reply' : 'complete reply' },
            finish_reason: interrupted ? null : 'stop',
          },
        ],
      }
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\n${interrupted ? '' : 'data: [DONE]\n\n'}`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    },
  })
  try {
    const attachments = await AttachmentService.open(root)
    const bytes = new TextEncoder().encode('%PDF-1.7\nfixture')
    const [attachment] = await attachments.store([
      { kind: 'pdf', mimeType: 'application/pdf', name: 'fixture.pdf', data: bytes },
    ])
    const inputId = 'input:fixture'
    await attachments.bind([attachment!.id], { type: 'input', id: inputId })
    const endpoint = `http://127.0.0.1:${server.port}/v1`
    const models = createModels()
    models.setProvider(
      createPiCustomProvider('fixture', {
        kind: 'custom',
        name: 'fixture',
        enabled: true,
        baseUrl: endpoint,
        auth: 'none',
        env: [],
        allowInsecureHttp: false,
        headers: {},
        models: {
          fixture: {
            id: 'fixture',
            api: 'openai-completions',
            name: 'fixture',
            enabled: true,
            contextWindow: 64_000,
            maxTokens: 128,
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            headers: {},
            mediaInput: { endpoint, protocol: 'openai-completions', pdf: true },
          },
        },
      }),
    )
    const repo = new InMemorySessionRepo()
    const session = await repo.create({ id: crypto.randomUUID() })
    let attachmentReads = 0
    const harness = new AgentHarness({
      session,
      models,
      model: models.getModel('fixture', 'fixture')!,
      modelRetry: 'bounded',
      streamOptions: { headers: { Authorization: 'Bearer fixture-key' } },
      readMediaAttachment: async ({ attachmentId }) => {
        attachmentReads++
        return (await attachments.read(attachmentId)).data
      },
    })
    const result = await harness.prompt('Read the attached PDF', {
      inputIds: [inputId],
      media: [
        {
          kind: 'pdf',
          attachmentId: attachment!.id,
          inputId,
          name: 'fixture.pdf',
          mimeType: 'application/pdf',
          sizeBytes: bytes.length,
        },
      ],
    })
    expect(result.content).toEqual([{ type: 'text', text: 'complete reply' }])
    expect(body).toHaveLength(2)
    expect(body[0]).toEqual(body[1])
    expect(JSON.stringify(body[1])).toContain(
      `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`,
    )
    expect(attachmentReads).toBe(1)
    expect(
      (await attachments.listByBinding({ type: 'input', id: inputId })).map(({ id }) => id),
    ).toEqual([attachment!.id])
    const { messages } = await session.buildContext()
    expect(messages.filter((message) => message.role === 'assistant')).toEqual([result])
    expect(JSON.stringify(messages)).not.toContain('discard this partial reply')
    expect(JSON.stringify(messages)).not.toContain(Buffer.from(bytes).toString('base64'))
  } finally {
    await server.stop(true)
    await removeFixturePath(root)
  }
})
