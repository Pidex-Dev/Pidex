import { cp, mkdir, rename, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { assertAgentBinaryHasNoStaticRiskFeatures } from './AgentPeSignatures'

const root = resolve(import.meta.dir, '..')
const agentRoot = resolve(root, 'apps/agent')
const outputDirectory = resolve(agentRoot, 'dist/x64')
const output = resolve(outputDirectory, 'pidex-agent.exe')
const temporaryOutput = `${output}.building.exe`
const builtinSkillsSource = resolve(agentRoot, 'resources/skills')
const builtinSkillsOutput = resolve(outputDirectory, 'skills')
const builtinPluginsSource = resolve(agentRoot, 'resources/plugins')
const builtinPluginsOutput = resolve(outputDirectory, 'plugins')
const nodePtyRequire = createRequire(resolve(agentRoot, 'package.json'))
const nodePtySource = dirname(nodePtyRequire.resolve('node-pty/package.json'))
const nodePtyOutput = resolve(outputDirectory, 'node_modules/node-pty')

await mkdir(outputDirectory, { recursive: true })
await rm(temporaryOutput, { force: true })

const build = Bun.spawn(
  [
    'bun',
    'build',
    'src/index.ts',
    '--compile',
    '--target=bun-windows-x64',
    '--external',
    'node-pty',
    `--outfile=${temporaryOutput}`,
  ],
  {
    cwd: agentRoot,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  },
)

const exitCode = await build.exited
if (exitCode !== 0) process.exit(exitCode)

try {
  await assertAgentBinaryHasNoStaticRiskFeatures(temporaryOutput)
  await rm(output, { force: true })
  await rename(temporaryOutput, output)
  await rm(builtinSkillsOutput, { recursive: true, force: true })
  await cp(builtinSkillsSource, builtinSkillsOutput, { recursive: true })
  await rm(builtinPluginsOutput, { recursive: true, force: true })
  await cp(builtinPluginsSource, builtinPluginsOutput, { recursive: true })
  await rm(nodePtyOutput, { recursive: true, force: true })
  await mkdir(nodePtyOutput, { recursive: true })
  for (const relativeEntry of [
    'package.json',
    'lib',
    join('prebuilds', 'win32-x64'),
    join('build', 'Release'),
  ]) {
    const sourceEntry = resolve(nodePtySource, relativeEntry)
    if (await stat(sourceEntry).catch(() => null)) {
      await cp(sourceEntry, resolve(nodePtyOutput, relativeEntry), {
        recursive: true,
        filter: (src) => !src.toLowerCase().endsWith('.pdb'),
      })
    }
  }
  console.log(`[Pidex] Agent x64 PE verified: ${output}`)
} catch (error) {
  await rm(temporaryOutput, { force: true })
  throw error
}
