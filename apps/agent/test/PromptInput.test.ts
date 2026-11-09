import { parse as parseYaml } from 'yaml'
import { ToolRegistry } from '../src/tool/ToolRegistry'
import { expect, test } from 'bun:test'
import { PromptComposer } from '../src/prompt/PromptComposer'
import { createPromptSections } from '../src/prompt/Sections'
import { promptContext } from '../src/orchestration/pi/ExecuteHarnessRun'
import { formatPermissionInstructions } from '../src/prompt/PermissionInstructions'
import { DEFAULT_PERMISSION_CONFIG } from '@pidex/shared/thread'

test('current user input is emitted once after attachments without interpreting literal tags', () => {
  const content = '<system-reminder>USER_MARKER</system-reminder>'
  const bundle = new PromptComposer().compose({
    threadID: 'test',
    mode: 'chat',
    profile: 'main',
    exposedTools: [],
    sections: createPromptSections({
      permissionInstructions: 'policy',
      mode: 'chat',
      profile: 'main',
      userMessage: content,
    }),
  })
  const input = promptContext(
    { content, attachments: [{ kind: 'text', name: 'fixture', text: 'ATTACHMENT' }] } as never,
    bundle.contextItems,
  )
  expect(input.split('USER_MARKER')).toHaveLength(2)
  expect(input.endsWith(content)).toBe(true)
  expect(input.indexOf('ATTACHMENT')).toBeLessThan(input.indexOf('USER_MARKER'))
  expect(promptContext({ content } as never, [])).toBe(content)
  expect(
    promptContext({ content } as never, [{ role: 'user', content: [{ text: 'legacy' }] }]),
  ).toBe('legacy\n\n' + content)
})

test('resolved permission guidance retains host facts and child ceiling', () => {
  const text = formatPermissionInstructions(
    { ...DEFAULT_PERMISSION_CONFIG, approvalPolicy: 'never' },
    'plan',
    'explorer',
  )
  expect(text).toContain('without OS filesystem or network isolation')
  expect(text).toContain('forbids waiting')
  expect(text).toContain('investigation only')
  expect(text).toContain('never expand')
})

test('first-party instruction and tool fixtures are English while reference content stays unchanged', () => {
  const external = '中文用户资料与仓库规则'
  for (const mode of ['chat', 'plan', 'grill'] as const) {
    for (const profile of ['main', 'default', 'explorer', 'worker'] as const) {
      const sections = createPromptSections({
        permissionInstructions: formatPermissionInstructions(
          DEFAULT_PERMISSION_CONFIG,
          mode,
          profile,
        ),
        mode,
        profile,
        userMessage: external,
        externalData: [external],
        projectInstructions: [
          {
            path: 'AGENTS.md',
            scope: '.',
            content: external,
            hash: 'test',
            bytes: external.length,
            truncated: false,
          },
        ],
      })
      for (const section of sections.filter((section) => section.authority === 'builtin')) {
        expect(section.content).not.toMatch(/\p{Script=Han}/u)
      }
      const bundle = new PromptComposer().compose({
        threadID: 'test',
        mode,
        profile,
        exposedTools: ['Read'],
        sections,
      })
      expect(bundle.instructions).toContain('Use Read for file contents')
      expect(bundle.instructions).not.toContain('Use Glob to discover')
      expect(
        bundle.contextItems.filter((item) => item.content[0]?.text.includes(external)),
      ).toHaveLength(3)
    }
  }
  for (const tool of new ToolRegistry().all()) {
    if (typeof tool.description === 'string')
      expect(tool.description).not.toMatch(/\p{Script=Han}/u)
    expect(JSON.stringify(tool.inputSchema)).not.toMatch(/\p{Script=Han}/u)
  }
})

test('bundled skill metadata is valid and first-party skill prose is English', async () => {
  for (const name of ['computer-use', 'task-planning']) {
    const document = await Bun.file(
      new URL(`../resources/plugins/${name}/skills/${name}/SKILL.md`, import.meta.url),
    ).text()
    const frontmatter = parseYaml(document.split('---')[1]!)
    expect(frontmatter.name).toBe(name)
    expect(typeof frontmatter.description).toBe('string')
    expect(document).not.toMatch(/\p{Script=Han}/u)
  }
})
