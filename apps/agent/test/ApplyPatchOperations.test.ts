import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeFixturePaths } from './FixtureCleanup'
import { ToolExecutor } from '../src/tool/ToolExecutor'
import { ToolRegistry } from '../src/tool/ToolRegistry'
import { WorkspaceService } from '../src/workspace/WorkspaceService'

const temporary: string[] = []
afterEach(async () => removeFixturePaths(temporary.splice(0)))

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'pidex-apply-patch-'))
  temporary.push(root)
  const workspace = await WorkspaceService.open(root)
  const executor = new ToolExecutor(new ToolRegistry(), {
    dataDir: join(root, '.agent-data'),
    userConfigPath: join(root, 'config.json'),
    authorizeShell: async () => ({ decision: 'allow', risk: 'low', reason: 'test' }),
  })
  const context = {
    threadID: 'thread',
    turnID: 'turn',
    taskMode: 'chat' as const,
    signal: new AbortController().signal,
    workspace,
  }
  return { root, executor, context }
}

const patch = (...lines: string[]) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')

const read = (root: string, path: string) => readFile(join(root, path), 'utf8')

const readBytes = async (root: string, path: string) =>
  Buffer.from(await Bun.file(join(root, path)).arrayBuffer())

describe('apply_patch delete and move', () => {
  test('deletes a read file and reports a null post-delete revision', async () => {
    const { root, executor, context } = await fixture()
    await writeFile(join(root, 'old.txt'), 'one\ntwo\n', 'utf8')
    await executor.execute('Read', { file_path: 'old.txt' }, context)

    const result = await executor.execute<any>(
      'apply_patch',
      { patch: patch('*** Delete File: old.txt') },
      context,
    )

    expect(await Bun.file(join(root, 'old.txt')).exists()).toBe(false)
    expect(result.files).toEqual([
      {
        operation: 'delete',
        path: 'old.txt',
        additions: 0,
        deletions: 2,
        beforeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        afterSha256: null,
        revision: null,
      },
    ])
    expect(result.summary).toEqual({ fileCount: 1, hunkCount: 0, additions: 0, deletions: 2 })
  })

  test('moves a file without hunks and preserves BOM plus mixed line endings', async () => {
    const { root, executor, context } = await fixture()
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    const original = Buffer.concat([bom, Buffer.from('first\r\nsecond\nthird\r\n', 'utf8')])
    await writeFile(join(root, 'from.txt'), original)
    await executor.execute('Read', { file_path: 'from.txt' }, context)

    const result = await executor.execute<any>(
      'apply_patch',
      { patch: patch('*** Update File: from.txt', '*** Move to: to.txt') },
      context,
    )

    expect(await Bun.file(join(root, 'from.txt')).exists()).toBe(false)
    expect(await readBytes(root, 'to.txt')).toEqual(original)
    expect(result.files).toMatchObject([
      {
        operation: 'create',
        path: 'to.txt',
        movedFrom: 'from.txt',
        afterSha256: expect.any(String),
      },
      {
        operation: 'delete',
        path: 'from.txt',
        movedTo: 'to.txt',
        afterSha256: null,
        revision: null,
      },
    ])
  })

  test('moves and edits in one operation while keeping untouched context bytes', async () => {
    const { root, executor, context } = await fixture()
    await writeFile(join(root, 'from.txt'), 'keep\r\ndrop\nkeep2', 'utf8')
    await executor.execute('Read', { file_path: 'from.txt' }, context)
    await mkdir(join(root, 'nested'))

    await executor.execute(
      'apply_patch',
      {
        patch: patch(
          '*** Update File: from.txt',
          '*** Move to: nested/to.txt',
          '@@',
          '-drop',
          '+kept',
        ),
      },
      context,
    )

    // Mixed line endings and the missing trailing newline must survive.
    expect(await read(root, 'nested/to.txt')).toBe('keep\r\nkept\nkeep2')
    expect(await Bun.file(join(root, 'from.txt')).exists()).toBe(false)
  })

  test('deletes and moves in the same batch, committing creates before deletes', async () => {
    const { root, executor, context } = await fixture()
    await writeFile(join(root, 'a.txt'), 'alpha\n', 'utf8')
    await writeFile(join(root, 'z.txt'), 'zeta\n', 'utf8')
    await executor.execute('Read', { file_path: 'a.txt' }, context)
    await executor.execute('Read', { file_path: 'z.txt' }, context)

    const result = await executor.execute<any>(
      'apply_patch',
      {
        patch: patch(
          '*** Delete File: z.txt',
          '*** Update File: a.txt',
          '*** Move to: zz.txt',
          '*** Add File: m.txt',
          '+middle',
        ),
      },
      context,
    )

    expect(await Bun.file(join(root, 'z.txt')).exists()).toBe(false)
    expect(await Bun.file(join(root, 'a.txt')).exists()).toBe(false)
    expect(await read(root, 'zz.txt')).toBe('alpha\n')
    expect(await read(root, 'm.txt')).toBe('middle\n')
    expect(
      result.files.map(
        (file: { operation: string; path: string }) => `${file.operation}:${file.path}`,
      ),
    ).toEqual(['delete:z.txt', 'create:zz.txt', 'delete:a.txt', 'create:m.txt'])
  })

  test('rejects delete and move without a full or current Read snapshot', async () => {
    const { root, executor, context } = await fixture()
    await writeFile(join(root, 'old.txt'), 'one\n', 'utf8')

    await expect(
      executor.execute('apply_patch', { patch: patch('*** Delete File: old.txt') }, context),
    ).rejects.toMatchObject({ code: 'WORKSPACE_FILE_STALE' })
    await expect(
      executor.execute(
        'apply_patch',
        { patch: patch('*** Update File: old.txt', '*** Move to: next.txt') },
        context,
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_FILE_STALE' })

    await executor.execute('Read', { file_path: 'old.txt' }, context)
    await writeFile(join(root, 'old.txt'), 'changed elsewhere\n', 'utf8')
    await expect(
      executor.execute('apply_patch', { patch: patch('*** Delete File: old.txt') }, context),
    ).rejects.toMatchObject({ code: 'WORKSPACE_FILE_STALE' })

    expect(await read(root, 'old.txt')).toBe('changed elsewhere\n')
    expect(await Bun.file(join(root, 'next.txt')).exists()).toBe(false)
  })

  test('rejects an existing move target and writes nothing', async () => {
    const { root, executor, context } = await fixture()
    await writeFile(join(root, 'from.txt'), 'from\n', 'utf8')
    await writeFile(join(root, 'taken.txt'), 'taken\n', 'utf8')
    await executor.execute('Read', { file_path: 'from.txt' }, context)

    await expect(
      executor.execute(
        'apply_patch',
        { patch: patch('*** Update File: from.txt', '*** Move to: taken.txt') },
        context,
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_PATH_EXISTS' })
    expect(await read(root, 'from.txt')).toBe('from\n')
    expect(await read(root, 'taken.txt')).toBe('taken\n')
  })

  test('rejects a patch that reuses a move target path elsewhere', async () => {
    const { root, executor, context } = await fixture()
    await writeFile(join(root, 'from.txt'), 'from\n', 'utf8')
    await writeFile(join(root, 'edit.txt'), 'edit\n', 'utf8')
    await executor.execute('Read', { file_path: 'from.txt' }, context)
    await executor.execute('Read', { file_path: 'edit.txt' }, context)

    await expect(
      executor.execute(
        'apply_patch',
        {
          patch: patch(
            '*** Update File: from.txt',
            '*** Move to: edit.txt',
            '*** Update File: edit.txt',
            '@@',
            '-edit',
            '+changed',
          ),
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'PATCH_DUPLICATE_PATH' })
    expect(await read(root, 'from.txt')).toBe('from\n')
    expect(await read(root, 'edit.txt')).toBe('edit\n')
  })

  test('rejects delete and move of the Pidex project config', async () => {
    const { root, executor, context } = await fixture()
    await mkdir(join(root, '.pidex'), { recursive: true })
    await writeFile(join(root, '.pidex', 'config.json'), '{"theme":"dark"}\n', 'utf8')
    await executor.execute('Read', { file_path: '.pidex/config.json' }, context)

    await expect(
      executor.execute(
        'apply_patch',
        { patch: patch('*** Delete File: .pidex/config.json') },
        context,
      ),
    ).rejects.toMatchObject({ code: 'PATCH_PROTECTED_CONFIG' })
    await expect(
      executor.execute(
        'apply_patch',
        { patch: patch('*** Update File: .pidex/config.json', '*** Move to: cfg.json') },
        context,
      ),
    ).rejects.toMatchObject({ code: 'PATCH_PROTECTED_CONFIG' })
    expect(await read(root, '.pidex/config.json')).toBe('{"theme":"dark"}\n')
  })
})

describe('apply_patch fidelity', () => {
  test('replaces only changed lines inside a hunk with mixed line endings', async () => {
    const { root, executor, context } = await fixture()
    const original = 'alpha\r\nbeta\nreplace me\r\ngamma\nlast'
    await writeFile(join(root, 'mixed.txt'), original, 'utf8')
    await executor.execute('Read', { file_path: 'mixed.txt' }, context)

    await executor.execute(
      'apply_patch',
      {
        patch: patch(
          '*** Update File: mixed.txt',
          '@@',
          ' alpha',
          ' beta',
          '-replace me',
          '+replaced',
          ' gamma',
        ),
      },
      context,
    )

    expect(await read(root, 'mixed.txt')).toBe('alpha\r\nbeta\nreplaced\r\ngamma\nlast')
  })

  test('keeps BOM and a missing trailing newline across two hunks', async () => {
    const { root, executor, context } = await fixture()
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    await writeFile(
      join(root, 'bom.txt'),
      Buffer.concat([bom, Buffer.from('first\r\nsecond\nthird\r\nfourth', 'utf8')]),
    )
    await executor.execute('Read', { file_path: 'bom.txt' }, context)

    await executor.execute(
      'apply_patch',
      {
        patch: patch(
          '*** Update File: bom.txt',
          '@@',
          '-second',
          '+SECOND',
          '@@',
          '-fourth',
          '+FOURTH',
          '*** End of File',
        ),
      },
      context,
    )

    expect(await readBytes(root, 'bom.txt')).toEqual(
      Buffer.concat([bom, Buffer.from('first\r\nSECOND\nthird\r\nFOURTH', 'utf8')]),
    )
  })
})
