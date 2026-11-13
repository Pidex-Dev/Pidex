import { desktopClient } from '../../services/desktop-client/index.js'
import { composerDraftStore } from '../session/composer/ComposerDraftStore.js'
import type { PluginCatalogItem } from './PluginCatalog.js'

export type PreparePluginPromptOptions = {
  /** Catalog revision the user confirmed; echo it so a moved catalog conflicts. */
  installRevision?: string | undefined
}

export async function preparePluginPrompt(
  item: PluginCatalogItem,
  prompt: string,
  options: PreparePluginPromptOptions = {},
) {
  if (composerDraftStore.get('home').document.text.trim())
    throw new Error('新聊天中已有草稿，请先处理该草稿后重试。')
  if (!item.installed) await desktopClient.installPlugin(item.id, options.installRevision)
  if (!item.enabled) await desktopClient.setPluginEnabled(item.id, true)
  composerDraftStore.prefillTextIfEmpty(
    'home',
    `[@${item.name.replace(/([\\[\]])/gu, '\\$1')}](plugin://${item.id}) ${prompt}`,
  )
}
