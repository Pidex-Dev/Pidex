import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { runHostCommand } from '../tool/Shell/HostProcess'
import type { HookToolRunner } from './HookService'

export interface HostHookRunnerOptions {
  dataDir: string
  resolveContext?: (input: { threadID?: string; workspaceRoot?: string }) => Promise<{
    cwd: string
    projectDir: string
  }>
}

function expandHookVariables(command: string, variables: Record<string, string>): string {
  return command.replace(
    /\$\{(CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|PLUGIN_DATA|CLAUDE_PROJECT_DIR)\}/g,
    (match, key: string) => variables[key] ?? match,
  )
}

/**
 * Executes user- and plugin-configured lifecycle hooks directly on the host.
 * Hook trust is gated at discovery/load time by HookService rather than through
 * the model-facing ToolExecutor shell risk classifier.
 */
export function createHostHookRunner(options: HostHookRunnerOptions): HookToolRunner {
  return {
    async run(input) {
      const resolved = options.resolveContext
        ? await options.resolveContext({
            ...(input.threadID ? { threadID: input.threadID } : {}),
            ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
          })
        : {
            cwd: input.workspaceRoot ?? process.cwd(),
            projectDir: input.workspaceRoot ?? process.cwd(),
          }

      const env: NodeJS.ProcessEnv = {
        CLAUDE_PROJECT_DIR: resolved.projectDir,
      }
      const templateVars: Record<string, string> = {
        CLAUDE_PROJECT_DIR: resolved.projectDir,
      }

      if (input.pluginRoot) {
        env.CLAUDE_PLUGIN_ROOT = input.pluginRoot
        env.PLUGIN_ROOT = input.pluginRoot
        templateVars.CLAUDE_PLUGIN_ROOT = input.pluginRoot
        templateVars.PLUGIN_ROOT = input.pluginRoot
        if (input.pluginId) {
          const pluginDataDir = join(options.dataDir, 'plugins', 'data', input.pluginId)
          await mkdir(pluginDataDir, { recursive: true })
          env.CLAUDE_PLUGIN_DATA = pluginDataDir
          env.PLUGIN_DATA = pluginDataDir
          templateVars.CLAUDE_PLUGIN_DATA = pluginDataDir
          templateVars.PLUGIN_DATA = pluginDataDir
        }
      }

      const expandedCommand = expandHookVariables(input.command, templateVars)
      // PowerShell `-Command` collapses non-zero native exit codes (such as exit 2
      // blocking hooks) to 1 unless $LASTEXITCODE is explicitly propagated.
      const command =
        process.platform === 'win32'
          ? `$global:LASTEXITCODE = 0; & { ${expandedCommand} }; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } elseif (-not $?) { exit 1 }`
          : expandedCommand
      const stdin = input.evidence.endsWith('\n') ? input.evidence : `${input.evidence}\n`
      const result = await runHostCommand(command, resolved.cwd, input.timeoutMs, undefined, env, stdin)

      if (result.timedOut) {
        throw new Error(`Hook ${input.hookID} 执行超时 (${input.timeoutMs}ms)`)
      }

      const stdout = result.stdout.trim()
      const stderr = result.stderr.trim()

      if (result.exitCode === 2) {
        return {
          output: JSON.stringify({
            decision: 'deny',
            reason: stderr || stdout || 'Hook 阻止执行',
          }),
        }
      }

      if (result.exitCode !== 0 && result.exitCode !== null) {
        throw new Error(stderr || stdout || `Hook 退出码 ${result.exitCode}`)
      }

      return {
        output: stdout || stderr,
      }
    },
  }
}
