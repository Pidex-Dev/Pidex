import { describe, expect, test } from 'bun:test'
import { ShellProfileService } from '../src/terminal/ShellProfileService'
import { TerminalError } from '../src/terminal/TerminalErrors'

describe('终端 Shell profile', () => {
  test('Windows 按 pwsh、Windows PowerShell、cmd 顺序选择首个可用项', () => {
    const service = new ShellProfileService({
      platform: 'win32',
      environment: {
        Path: 'C:\\Tools',
        SystemRoot: 'C:\\Windows',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      },
      fileExists: (path) =>
        [
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          'C:\\Windows\\System32\\cmd.exe',
        ].includes(path),
    })
    expect(service.list().find((profile) => profile.isDefault)?.id).toBe('windows-powershell')
    expect(service.resolve(null).id).toBe('windows-powershell')
  })

  test('Windows 从 PATH 上的 Git 和用户安装目录发现 Bash', () => {
    for (const root of ['C:\\PortableGit', 'C:\\Local\\Programs\\Git']) {
      const files = new Set([root + '\\bin\\bash.exe', root + '\\cmd\\git.exe'])
      const service = new ShellProfileService({
        platform: 'win32',
        environment: {
          Path: root.includes('Portable') ? root + '\\cmd' : '',
          LOCALAPPDATA: 'C:\\Local',
        },
        fileExists: (path) => files.has(path),
      })
      expect(service.resolve('git-bash').executable).toBe(root + '\\bin\\bash.exe')
    }
  })

  test('只能解析探测结果中的可用 opaque profile ID', () => {
    const service = new ShellProfileService({
      platform: 'linux',
      environment: { SHELL: '/bin/bash' },
      fileExists: (path) => path === '/bin/bash',
    })
    expect(service.resolve('bash').executable).toBe('/bin/bash')
    expect(() => service.resolve('/tmp/custom-shell')).toThrow(TerminalError)
  })
})
