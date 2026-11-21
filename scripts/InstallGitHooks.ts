import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Result of configuring local Git hooks to use `.githooks`. */
export interface InstallGitHooksResult {
  gitRoot: string
  hooksPath: string
  prePushPath: string
  executableChanged: boolean
}

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  }).trim()
}

/** Configures `core.hooksPath` to `.githooks` and ensures `.githooks/pre-push` is executable. */
export function installGitHooks(startDir = process.cwd()): InstallGitHooksResult {
  const gitRoot = runGit(['rev-parse', '--show-toplevel'], startDir)
  const hooksDirName = '.githooks'
  const prePushPath = join(gitRoot, hooksDirName, 'pre-push')

  if (!existsSync(prePushPath)) {
    throw new Error(`Expected hook file was not found at ${prePushPath}.`)
  }

  runGit(['config', 'core.hooksPath', hooksDirName], gitRoot)
  const configuredHooksPath = runGit(['config', '--get', 'core.hooksPath'], gitRoot)
  if (configuredHooksPath !== hooksDirName) {
    throw new Error(
      `Failed to verify git core.hooksPath: expected "${hooksDirName}", got "${configuredHooksPath}".`,
    )
  }

  let executableChanged = false
  if (process.platform !== 'win32') {
    const modeBefore = statSync(prePushPath).mode
    chmodSync(prePushPath, 0o755)
    const modeAfter = statSync(prePushPath).mode
    executableChanged = modeBefore !== modeAfter
  }

  return {
    gitRoot,
    hooksPath: configuredHooksPath,
    prePushPath,
    executableChanged,
  }
}

if (import.meta.main) {
  try {
    const result = installGitHooks()
    console.log(`[hooks] Git root: ${result.gitRoot}`)
    console.log(`[hooks] Configured core.hooksPath = ${result.hooksPath}`)
    console.log(`[hooks] Verified hook script: ${result.prePushPath}`)
    if (process.platform !== 'win32') {
      console.log(
        `[hooks] POSIX permissions set to 0755 (${result.executableChanged ? 'updated' : 'already executable'}).`,
      )
    } else {
      console.log(
        '[hooks] Windows host detected; Git for Windows executes .githooks/pre-push via sh.',
      )
    }
    console.log('[hooks] PASS: local pre-push governance hooks installed.')
  } catch (error) {
    console.error(`[hooks] FAIL: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
