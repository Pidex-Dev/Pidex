import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RENDERER_CAPABILITIES } from '../src/services/desktop-client/AgentSessionClient.js'

// 验收 P1（模型参数保存必现失败）的根因之一是 Renderer 未申请该能力，
// 导致 provider/modelPreferences/* 被 CAPABILITY_REQUIRED 拒绝；锁住协商清单防回归。
test('renderer negotiates the model runtime preference capability', () => {
  expect(RENDERER_CAPABILITIES).toContain('model.preferences.v1')
})

// 协商是取交集：代码里 require 了但清单没申请的能力永远不可用（Hook 管理、记忆设置曾因此整页失效）。
const ALIASES: Record<string, string> = {
  prompt: 'prompt.preview.sensitive.v1',
  memory: 'memory.v3',
  compact: 'context.compact.v1',
  hookTrust: 'hooks.trust.v1',
}

test('every capability the renderer requires is also requested during initialize', () => {
  const source = readFileSync(
    join(import.meta.dir, '../src/services/desktop-client/AgentSessionClient.ts'),
    'utf8',
  )
  const required = new Set(
    [...source.matchAll(/requireAgentCapability\('([a-z0-9.-]+)'/g)].map(
      (match) => ALIASES[match[1]!] ?? match[1]!,
    ),
  )
  const missing = [...required].filter(
    (capability) => !(RENDERER_CAPABILITIES as readonly string[]).includes(capability),
  )
  expect(missing).toEqual([])
})
