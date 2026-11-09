import type { PluginManagementService } from './PluginManagementService'
import type { SkillMetadata } from '../prompt/SkillService'

export function extractPluginReferences(content: string): string[] {
  const text = content
    .replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)/g, '$1')
    .replace(/(`+)[\s\S]*?\1/g, '')
  return [
    ...new Set(
      [
        ...text.matchAll(
          /(?<!!)\[(?:\\.|[^\]\\\n])*\]\((?:plugin:\/\/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)|<plugin:\/\/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)>)\)/g,
        ),
      ].map((match) => match[1] ?? match[2]!),
    ),
  ]
}

export async function pluginReferenceData(
  content: string,
  plugins: PluginManagementService | undefined,
  workspace: string,
  skills: readonly SkillMetadata[],
): Promise<string[]> {
  const ids = extractPluginReferences(content)
  if (!ids.length) return []
  const catalog = plugins ? (await plugins.listLocal(workspace)).plugins : []
  return ids.map((id) => {
    const plugin = catalog.find((entry) => entry.id === id)
    if (
      !plugin?.installed ||
      !plugin.enabled ||
      plugin.status !== 'ready' ||
      !plugins?.isEnabled(id)
    )
      return `Referenced plugin ${JSON.stringify(id)} is unavailable; references cannot enable plugins or grant permissions.`
    const availableSkills = skills.filter((skill) =>
      skill.path.startsWith(`plugin://${id}/skills/`),
    )
    return `The user referenced this plugin: ${JSON.stringify({
      id,
      name: plugin.name,
      description: plugin.description,
      capabilities: plugin.capabilities,
      skills: availableSkills.map((skill) => ({
        name: skill.name,
        path: skill.path,
        location: skill.documentPath,
      })),
    })}\nUse Read to load the listed SKILL.md files as needed. A reference expresses intent only; tools remain subject to live enablement and host authorization.`
  })
}
