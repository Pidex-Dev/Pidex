import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { Model, Provider } from '@pidex/model-schema'
import { DEFAULT_PERMISSION_CONFIG } from '@pidex/shared/thread'
import { removeFixturePaths } from './FixtureCleanup'
import { ThreadService } from '../src/session/ThreadService'
import { AgentDatabase } from '../src/storage/database/AgentDatabase'
import { AttachmentService } from '../src/subagent/AttachmentService'
import { SqliteAttachmentCatalog } from '../src/subagent/SqliteAttachmentCatalog'

const roots: string[] = []
afterEach(async () => {
  await removeFixturePaths(roots.splice(0))
})

const model = Model.Ref.make({
  providerID: Provider.ID.make('vision-provider'),
  id: Model.ID.make('vision-model'),
})

async function fixture(providersOverride?: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'pidex-thread-attachment-'))
  roots.push(root)
  const db = new AgentDatabase(join(root, 'agent.sqlite'))
  const attachments = await AttachmentService.open(root, {
    catalog: new SqliteAttachmentCatalog(db),
  })
  const questions = { setResumeHandler: () => undefined }
  const subagents = {
    resolvedWaitCheckpoint: () => null,
    setParentResumeHandler: () => undefined,
  }
  const service = new ThreadService(
    db,
    { publish: () => Effect.void } as never,
    (providersOverride ?? {
      resolve: async () => ({ capabilities: { input: ['text', 'image'], tools: true } }),
    }) as never,
    null as never,
    questions as never,
    { clearTurnPermissionGrants: () => undefined } as never,
    subagents as never,
    attachments,
    { dataRoot: root, userHome: root },
    null as never,
    null as never,
    { resolve: async () => ({}) } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
  )
  return { db, attachments, service }
}

async function imageAttachment(attachments: AttachmentService) {
  const [attachment] = await attachments.store([
    {
      kind: 'image',
      name: 'screen.png',
      mimeType: 'image/png',
      data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    },
  ])
  return attachment!
}

describe('ThreadService 附件 admission', () => {
  test('没有正文、Skill 或附件的消息仍被拒绝', async () => {
    const { db, service } = await fixture()
    try {
      const thread = db.createThread()
      await expect(
        service.startTurn(
          thread.id,
          {
            content: '',
            model,
            permissionConfig: DEFAULT_PERMISSION_CONFIG,
            strategy: 'start',
            taskMode: 'chat',
          },
          'input:empty',
        ),
      ).rejects.toMatchObject({ code: 'EMPTY_MESSAGE' })
    } finally {
      db.close()
    }
  })
  test('Turn 模型不可用时返回清晰配置错误且不回退到目录其它模型', async () => {
    const otherModel = Model.Info.empty(
      Provider.ID.make('other-provider'),
      Model.ID.make('other-model'),
    )
    const { db, service } = await fixture({
      resolve: async () => {
        throw new Error('model unavailable')
      },
      models: async () => [otherModel],
    })
    const thread = db.createThread()
    await expect(
      service.startTurn(
        thread.id,
        {
          content: 'hello',
          model: Model.Ref.make({
            providerID: Provider.ID.make('missing-provider'),
            id: Model.ID.make('missing-model'),
          }),
          permissionConfig: DEFAULT_PERMISSION_CONFIG,
          strategy: 'start',
          taskMode: 'chat',
        },
        'input:missing-model',
      ),
    ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
    db.close()
  })

  test('排队追问创建 input 后在同一事务绑定图片', async () => {
    const { db, attachments, service } = await fixture()
    const thread = db.createThread()
    db.createTurn(
      thread.id,
      {
        content: '正在执行',
        model,
        permissionConfig: DEFAULT_PERMISSION_CONFIG,
        strategy: 'start',
        taskMode: 'chat',
      },
      'running',
    )
    const attachment = await imageAttachment(attachments)

    const result = await service.enqueueFollowUp(
      thread.id,
      {
        content: '',
        model,
        permissionConfig: DEFAULT_PERMISSION_CONFIG,
        strategy: 'queue',
        taskMode: 'chat',
      },
      'input:queue-image',
      [attachment.id],
    )

    expect(result.disposition).toBe('queued')
    expect(db.getTurnInput(result.turnID)?.content).toBe('')
    await service.updateQueue(thread.id, result.inputID, '', undefined, undefined, {
      operationID: 'queue:keep-image',
    })
    await expect(
      service.updateQueue(thread.id, result.inputID, '', [], [], {
        operationID: 'queue:remove-image',
      }),
    ).rejects.toMatchObject({ code: 'EMPTY_MESSAGE' })
    expect(await attachments.listByBinding({ type: 'input', id: result.inputID })).toMatchObject([
      {
        id: attachment.id,
        binding: { type: 'input', id: result.inputID },
      },
    ])
    db.close()
  })

  test('附件原始字节未超限但本轮编码超过当前端点预算时阻止入队', async () => {
    const { db, attachments, service } = await fixture({
      resolve: async () => ({ capabilities: { input: ['text', 'pdf'], tools: true } }),
      getPiModel: async () => ({
        api: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        input: ['text'],
        catalog: { input: ['pdf'] },
      }),
    })
    try {
      const thread = db.createThread()
      const stored = await attachments.store(
        [20, 3].map((size) => {
          const data = Buffer.alloc(size * 1024 * 1024)
          data.write('%PDF-1.7')
          return { kind: 'pdf', name: `${size}.pdf`, mimeType: 'application/pdf', data }
        }),
      )
      await expect(
        service.enqueueFollowUp(
          thread.id,
          {
            content: '',
            model,
            permissionConfig: DEFAULT_PERMISSION_CONFIG,
            strategy: 'queue',
            taskMode: 'chat',
          },
          'input:oversized-native-request',
          stored.map((record) => record.id),
        ),
      ).rejects.toMatchObject({ code: 'ATTACHMENT_TOTAL_TOO_LARGE' })
      expect(db.inputAdmission('input:oversized-native-request')).toBeNull()
      expect(
        (await attachments.getMany(stored.map((record) => record.id))).every(
          (record) => !record.binding,
        ),
      ).toBe(true)
    } finally {
      db.close()
    }
  })

  test('运行中引导创建 input 后在同一事务绑定图片', async () => {
    const { db, attachments, service } = await fixture()
    const thread = db.createThread()
    const active = db.createTurn(
      thread.id,
      {
        content: '正在执行',
        model,
        permissionConfig: DEFAULT_PERMISSION_CONFIG,
        strategy: 'start',
        taskMode: 'chat',
      },
      'running',
    )
    const attachment = await imageAttachment(attachments)

    const result = await service.steerTurn(
      thread.id,
      active.turnID,
      {
        content: '',
        model,
        permissionConfig: DEFAULT_PERMISSION_CONFIG,
        strategy: 'guide',
        taskMode: 'chat',
      },
      'input:steer-image',
      [attachment.id],
    )

    expect(result.disposition).toBe('steered')
    expect(await attachments.listByBinding({ type: 'input', id: result.inputID })).toMatchObject([
      {
        id: attachment.id,
        binding: { type: 'input', id: result.inputID },
      },
    ])
    db.close()
  })
})
