import type { DecisionPointManifest } from '@pidex/shared/decision'
import { CONTEXT_MANIFEST, CONTEXT_SPECS } from './ContextSpecs'
import { INPUT_MANIFEST, INPUT_SPECS } from './InputSpecs'
import { MEMORY_MANIFEST, MEMORY_SPECS } from './MemorySpecs'
import { SAFETY_MANIFEST, SAFETY_SPECS } from './SafetySpecs'
import { TEAMWORK_MANIFEST, TEAMWORK_SPECS } from './TeamworkSpecs'
import { TURN_MANIFEST, TURN_SPECS } from './TurnSpecs'

export * from './InputSpecs'
export * from './ContextSpecs'
export * from './MemorySpecs'
export * from './TeamworkSpecs'
export * from './SafetySpecs'
export * from './TurnSpecs'

/** Every Phase 3 decision point, keyed by spec id. */
export const INPUT_CONTEXT_MEMORY_TEAMWORK_SPECS = {
  ...INPUT_SPECS,
  ...CONTEXT_SPECS,
  ...MEMORY_SPECS,
  ...TEAMWORK_SPECS,
} as const

/** Registration list for the orchestrator: pass to DecisionService.registerManifest once at assembly. */
export const INPUT_CONTEXT_MEMORY_TEAMWORK_MANIFEST: readonly DecisionPointManifest[] = [
  ...INPUT_MANIFEST,
  ...CONTEXT_MANIFEST,
  ...MEMORY_MANIFEST,
  ...TEAMWORK_MANIFEST,
]

/** Every Phase 2 decision point (safety + turn), keyed by spec id. */
export const SAFETY_TURN_SPECS = {
  ...SAFETY_SPECS,
  ...TURN_SPECS,
} as const

/** Phase 2 registration list for the orchestrator: pass to DecisionService.registerManifest once at assembly. */
export const SAFETY_TURN_MANIFEST: readonly DecisionPointManifest[] = [
  ...SAFETY_MANIFEST,
  ...TURN_MANIFEST,
]
