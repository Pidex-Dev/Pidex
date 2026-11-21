import { describe, expect, test } from 'bun:test'
import { loadCachedRuntimeSkills } from '../src/features/session/composer/DesktopComposer.js'
import {
  getActiveComposerMention,
  resolveComposerSubmitIntent,
  shouldSubmitComposerKey,
} from '../src/features/session/composer/ComposerCard.js'
import {
  filterComposerCommands,
  getActiveSlashCommandQuery,
  getActiveSkillTokenQuery,
  mergeSlashCommands,
  parseSlashInvocation,
  skillToComposerCommand,
  type ComposerSlashCommand,
} from '../src/features/session/composer/ComposerSlashCommands.js'

describe('composer suggestions', () => {
  test('技能刷新不复用旧请求，晚到的目录不会覆盖新缓存', async () => {
    const workspace = `race-${crypto.randomUUID()}`
    const resolvers: Array<(skills: ReturnType<typeof installedSkill>[]) => void> = []
    const loader = () =>
      new Promise<ReturnType<typeof installedSkill>[]>((resolve) => {
        resolvers.push(resolve)
      })
    const old = loadCachedRuntimeSkills(workspace, false, loader)
    const fresh = loadCachedRuntimeSkills(workspace, true, loader)
    resolvers[1]!([installedSkill('fresh')])
    await fresh
    resolvers[0]!([installedSkill('old')])
    await old
    expect(
      (await loadCachedRuntimeSkills(workspace, false, loader)).map((skill) => skill.name),
    ).toEqual(['fresh'])
  })
  test('loads enabled runtime skills once per workspace and refreshes on demand', async () => {
    let calls = 0
    const loader = async () => {
      calls += 1
      return [installedSkill('review'), { ...installedSkill('disabled'), enabled: false }]
    }
    const workspace = `workspace-${crypto.randomUUID()}`

    const [first, second] = await Promise.all([
      loadCachedRuntimeSkills(workspace, false, loader),
      loadCachedRuntimeSkills(workspace, false, loader),
    ])

    expect(calls).toBe(1)
    expect(second).toEqual(first)
    expect(first.map((skill) => skill.name)).toEqual(['review'])

    await loadCachedRuntimeSkills(workspace, true, loader)
    expect(calls).toBe(2)
  })

  test('merges available commands with skills and keeps builtins on trigger collisions', () => {
    const builtins = [
      builtin('model', '模型', '选择模型'),
      builtin('status', '状态', '显示上下文用量'),
    ]
    const skills = [
      skillToComposerCommand(installedSkill('model')),
      skillToComposerCommand(installedSkill('review')),
    ]

    const merged = mergeSlashCommands(builtins, skills)
    expect(merged.map((command) => command.id)).toEqual(['model', 'status', 'skill:review'])
    expect(filterComposerCommands(merged, '上下文').map((item) => item.id)).toEqual(['status'])
  })

  test('keeps temporarily disabled commands and hides commands outside the environment', () => {
    const disabled = builtin('compact', '压缩', '压缩上下文', false)
    const hidden = {
      ...builtin('side', '侧边聊天', '打开侧边聊天'),
      availability: { visible: false, enabled: true },
    }
    expect(mergeSlashCommands([disabled, hidden], []).map((item) => item.id)).toEqual(['compact'])
  })

  test('detects a slash command query at the cursor without replacing the draft', () => {
    expect(getActiveSlashCommandQuery('继续处理 /rev 后续', 9)).toEqual({
      start: 5,
      end: 9,
      query: 'rev',
    })
    expect(getActiveSlashCommandQuery('https://example.com', 8)).toBeNull()
  })

  test('parses only exact registered slash commands', async () => {
    let executions = 0
    const status = builtin('status', '状态', '显示状态', true, () => {
      executions += 1
    })
    const compact = builtin(
      'compact',
      '压缩',
      '压缩上下文',
      false,
      () => {},
      '任务运行期间不能压缩上下文',
    )

    const parsed = parseSlashInvocation('/status', [status, compact])
    expect(parsed.kind).toBe('builtin')
    if (parsed.kind === 'builtin') await parsed.command.execute()
    expect(executions).toBe(1)
    expect(parseSlashInvocation('/status abc', [status]).kind).toBe('unknown')
    expect(parseSlashInvocation('/foo', [status]).kind).toBe('unknown')
    expect(parseSlashInvocation('/compact', [compact])).toMatchObject({
      kind: 'disabled',
      reason: '任务运行期间不能压缩上下文',
    })
  })

  test('detects the skill token under the cursor', () => {
    expect(getActiveSkillTokenQuery('请用 $review', 10)).toEqual({
      start: 3,
      end: 10,
      query: 'review',
    })
    expect(getActiveSkillTokenQuery('$review 后续', 7)).toEqual({
      start: 0,
      end: 7,
      query: 'review',
    })
    expect(getActiveSkillTokenQuery('价格$review', 9)).toBeNull()
  })

  test('recognizes only the mention under the cursor', () => {
    expect(getActiveComposerMention('检查 @review', 10)).toEqual({
      start: 3,
      end: 10,
      query: 'review',
    })
    expect(getActiveComposerMention('检查 @review-more', 10)).toBeNull()
    expect(getActiveComposerMention('email@example.com', 9)).toBeNull()
  })

  test('supports Enter and both Ctrl+Enter submission modes without breaking IME', () => {
    const event = {
      key: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      keyCode: 13,
    }
    expect(shouldSubmitComposerKey(event, 'enter', '单行')).toBe(true)
    expect(shouldSubmitComposerKey(event, 'multiline-ctrl-enter', '一\n二')).toBe(false)
    expect(
      shouldSubmitComposerKey({ ...event, ctrlKey: true }, 'multiline-ctrl-enter', '一\n二'),
    ).toBe(true)
    expect(shouldSubmitComposerKey(event, 'ctrl-enter', '单行')).toBe(false)
    expect(shouldSubmitComposerKey({ ...event, isComposing: true }, 'enter', '输入中')).toBe(false)
    expect(resolveComposerSubmitIntent(event, 'enter', '单行')).toBe('default')
    expect(resolveComposerSubmitIntent({ ...event, ctrlKey: true }, 'enter', '下一轮')).toBe(
      'follow-up',
    )
    expect(
      resolveComposerSubmitIntent({ ...event, isComposing: true }, 'enter', '输入中'),
    ).toBeNull()
  })
})

function installedSkill(name: string) {
  return {
    name,
    description: `${name} skill`,
    path: `F:\\skills\\${name}\\SKILL.md`,
    scope: 'repo' as const,
    source: 'workspace' as const,
    format: 'agents' as const,
    enabled: true,
  }
}

function builtin(
  id: ComposerSlashCommand['id'],
  title: string,
  description: string,
  enabled = true,
  execute: () => void | Promise<void> = () => {},
  disabledReason?: string,
): ComposerSlashCommand {
  return {
    id,
    trigger: id,
    title,
    description,
    source: 'builtin',
    availability: {
      visible: true,
      enabled,
      ...(disabledReason ? { disabledReason } : {}),
    },
    execute,
  }
}
