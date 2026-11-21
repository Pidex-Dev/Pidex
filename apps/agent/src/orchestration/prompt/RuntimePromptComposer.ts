import type { PermissionConfig } from '@pidex/shared/thread'
import type { SubagentProfile, TaskMode } from '../../Domain'
import { buildCapabilityCatalogSection } from '../../prompt/CapabilityCatalog'
import { formatPermissionInstructions } from '../../prompt/PermissionInstructions'
import { PromptComposer } from '../../prompt/PromptComposer'
import type { PromptSection } from '../../prompt/Types'
import { toolCatalogSummary, type ToolCatalog } from '../../tool/ToolRegistry'

/**
 * Only tools the given turn may already discover appear in the summary; the
 * frozen deferred envelope is therefore never widened by a live registry.
 */
export const capabilityCatalogSection = (
  catalog: ToolCatalog,
  deferredNames: readonly string[],
): PromptSection => {
  const byName = new Map(catalog.all().map((tool) => [tool.sdkName, tool]))
  return buildCapabilityCatalogSection(
    deferredNames.flatMap((name) => {
      const definition = byName.get(name)
      return definition ? [toolCatalogSummary(definition)] : []
    }),
  )
}

export const resolveRuntimePromptSections = (input: {
  sections?: readonly PromptSection[]
  effectivePermissionConfig: PermissionConfig
  taskMode: TaskMode
  profile: SubagentProfile
  toolCatalog: ToolCatalog
  deferredToolNames: readonly string[]
}): PromptSection[] => {
  const effectivePromptSections = (input.sections ?? []).map((section) =>
    section.id === 'permission.resolved'
      ? {
          ...section,
          content: formatPermissionInstructions(
            input.effectivePermissionConfig,
            input.taskMode,
            input.profile,
          ),
        }
      : section,
  )
  // The capability summary is part of the prompt that gets frozen, so a
  // resumed turn keeps the catalogue it started with. It is generated once for
  // the main Agent and subagents instead of being declared per tool.
  effectivePromptSections.splice(
    effectivePromptSections.length - 1,
    0,
    capabilityCatalogSection(input.toolCatalog, input.deferredToolNames),
  )
  return effectivePromptSections
}

export const composeRuntimePromptBundle = (input: {
  threadID: string
  mode: TaskMode
  profile: SubagentProfile
  exposedTools: readonly string[]
  sections: readonly PromptSection[]
}) =>
  new PromptComposer().compose({
    threadID: input.threadID,
    mode: input.mode,
    profile: input.profile,
    exposedTools: input.exposedTools,
    sections: input.sections,
  })
