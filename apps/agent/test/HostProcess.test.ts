import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  boundedTimeout,
  collectProcess,
  mergeProcessEnvironment,
  type CapturedChild,
} from '../src/tool/Shell/HostProcess'

describe('宿主 Shell 进程', () => {
  test('环境覆盖保持键名大小写不重复，超时值有界', () => {
    expect(mergeProcessEnvironment({ Path: 'base', KEEP: 'yes' }, { PATH: 'managed' })).toEqual({
      KEEP: 'yes',
      PATH: 'managed',
    })
    expect(boundedTimeout(undefined)).toBe(120_000)
    expect(boundedTimeout(900_000)).toBe(600_000)
    expect(() => boundedTimeout(0)).toThrow()
  })

  test('输出超过上限时截断但仍正常回收进程', async () => {
    const child = spawn(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(1024 * 1024 + 128))"],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ) as CapturedChild
    const result = await collectProcess(child, 30_000)
    expect(result.exitCode).toBe(0)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(1024 * 1024)
  })

  test('超时会终止整个宿主进程树', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as CapturedChild
    const result = await collectProcess(child, 25)
    expect(result.timedOut).toBe(true)
  })

  test('增量剥离 stdout 与 stderr 中的跨块 ANSI 控制序列', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        [
          "process.stdout.write('\\u001b[31;')",
          "setTimeout(() => { process.stdout.write('1m$ tsc -b\\u001b[0m\\n'); process.stderr.write('\\u001b[33mwarn\\u001b[0m') }, 10)",
        ].join(';'),
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ) as CapturedChild
    const result = await collectProcess(child, 30_000)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('$ tsc -b\n')
    expect(result.stderr).toBe('warn')
  })
})
