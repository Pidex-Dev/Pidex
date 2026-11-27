/**
 * Custom Oxlint JS plugin enforcing that the model selector always exposes
 * models added or customized on the Provider Page, rather than restricting
 * selectable models to upstream provider catalog lists.
 */

const BUILTIN_OVERRIDES_SUFFIX = 'apps/agent/src/provider/runtime/BuiltinProviderOverrides.ts'
const MODEL_SERVICE_SUFFIX = 'apps/agent/src/provider/runtime/ModelService.ts'
const MODEL_SELECTOR_SUFFIXES = [
  'apps/desktop/renderer/src/features/layout/UseModelProviderController.ts',
  'apps/desktop/renderer/src/features/session/composer/ModelPickerPopover.tsx',
  'apps/desktop/renderer/src/features/settings/SpecializedModelSelect.tsx',
  'apps/desktop/renderer/src/features/settings/SpecializedModelProviders.ts',
]

const FORBIDDEN_SELECTOR_IDENTIFIERS = new Set([
  'discoverProviderModels',
  'discoverBuiltinModels',
  'discoverDirectoryModels',
  'catalogModelCount',
])

const FORBIDDEN_MODELS_LIST_IDENTIFIERS = new Set([
  'directoryBaseProviders',
  'providerCatalog',
  'directoryEntries',
  'discoverBuiltinModels',
  'discoverDirectoryModels',
  'activeCatalogModelIDs',
])

const FORBIDDEN_MODEL_ENABLED_IDENTIFIERS = new Set([
  'providerCatalog',
  'directoryBaseProviders',
  'directoryEntries',
])

function normalizeFilename(filename) {
  return String(filename || '').replaceAll('\\', '/')
}

function isCatalogIdentifier(node) {
  if (!node || typeof node !== 'object') return false
  if (node.type === 'Identifier' && node.name === 'catalog') return true
  if (node.type === 'UnaryExpression' && node.operator === '!') {
    return isCatalogIdentifier(node.argument)
  }
  return false
}

function containsCatalogIdentifier(node) {
  if (!node || typeof node !== 'object') return false
  if (node.type === 'Identifier' && node.name === 'catalog') return true
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue
    if (Array.isArray(value)) {
      if (value.some((item) => containsCatalogIdentifier(item))) return true
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      if (containsCatalogIdentifier(value)) return true
    }
  }
  return false
}

function isEmptyArrayExpression(node) {
  return Boolean(node && node.type === 'ArrayExpression' && node.elements.length === 0)
}

function walkEstree(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && typeof item.type === 'string') {
          walkEstree(item, visit)
        }
      }
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      walkEstree(value, visit)
    }
  }
}

function hasMemberAccess(node, objectName, propertyName) {
  let found = false
  walkEstree(node, (current) => {
    if (found) return
    if (
      current.type === 'MemberExpression' &&
      !current.computed &&
      current.object?.type === 'Identifier' &&
      current.object.name === objectName &&
      current.property?.type === 'Identifier' &&
      current.property.name === propertyName
    ) {
      found = true
    }
  })
  return found
}

function checkBuiltinOverrides(context, programNode) {
  let overrideFn = null
  walkEstree(programNode, (node) => {
    if (
      !overrideFn &&
      node.type === 'FunctionDeclaration' &&
      node.id?.name === 'withBuiltinProviderOverrides'
    ) {
      overrideFn = node
    }
  })
  if (!overrideFn) return

  let configuredExtraDeclarator = null
  let foundChangedApi = null
  let foundEndpointModel = null

  walkEstree(overrideFn, (node) => {
    if (
      node.type === 'VariableDeclarator' &&
      node.id?.type === 'Identifier' &&
      node.id.name === 'configuredExtraIds'
    ) {
      configuredExtraDeclarator = node
      if (
        node.init?.type === 'ConditionalExpression' &&
        containsCatalogIdentifier(node.init.test) &&
        (isEmptyArrayExpression(node.init.consequent) ||
          isEmptyArrayExpression(node.init.alternate))
      ) {
        context.report({
          node: node.init,
          message:
            'withBuiltinProviderOverrides must not drop configuredExtraIds when catalog is present; models added or customized on the Provider Page must always remain selectable.',
        })
      }
      if (node.init?.type === 'LogicalExpression' && containsCatalogIdentifier(node.init.left)) {
        context.report({
          node: node.init,
          message:
            'withBuiltinProviderOverrides must not gate configuredExtraIds on catalog presence.',
        })
      }
    }

    if (
      node.type === 'VariableDeclarator' &&
      node.id?.type === 'Identifier' &&
      node.id.name === 'changedApi'
    ) {
      foundChangedApi = node
    }
    if (
      node.type === 'VariableDeclarator' &&
      node.id?.type === 'Identifier' &&
      node.id.name === 'endpointModel'
    ) {
      foundEndpointModel = node
    }

    if (node.type === 'IfStatement' && isCatalogIdentifier(node.test)) {
      const consequentHasExtraLoop = (() => {
        let matched = false
        walkEstree(node.consequent, (inner) => {
          if (inner.type === 'Identifier' && inner.name === 'configuredExtraIds') {
            matched = true
          }
        })
        return matched
      })()
      if (consequentHasExtraLoop) {
        context.report({
          node,
          message:
            'withBuiltinProviderOverrides must not gate configured extra model synthesis behind a catalog check.',
        })
      }
    }
  })

  for (const helper of [foundChangedApi, foundEndpointModel]) {
    if (!helper) continue
    walkEstree(helper, (node) => {
      if (node.type === 'IfStatement' && isCatalogIdentifier(node.test)) {
        context.report({
          node,
          message: `${helper.id.name} must check whether the model is bound in catalog.models (e.g. catalog?.models[model.id]) instead of unconditionally skipping all models when catalog exists.`,
        })
      }
    })
  }

  if (
    !configuredExtraDeclarator ||
    !hasMemberAccess(configuredExtraDeclarator, 'config', 'models') ||
    !hasMemberAccess(configuredExtraDeclarator, 'config', 'allowModels')
  ) {
    context.report({
      node: configuredExtraDeclarator ?? overrideFn,
      message:
        'withBuiltinProviderOverrides must synthesize extra configured models from both config.models and config.allowModels so Provider Page additions remain visible in the model selector.',
    })
  }
}

function checkModelService(context, programNode) {
  walkEstree(programNode, (node) => {
    if (node.type !== 'MethodDefinition' || node.key?.type !== 'Identifier') return
    const methodName = node.key.name
    if (methodName === 'models') {
      walkEstree(node.value, (inner) => {
        if (
          inner.type === 'MemberExpression' &&
          !inner.computed &&
          inner.property?.type === 'Identifier' &&
          FORBIDDEN_MODELS_LIST_IDENTIFIERS.has(inner.property.name)
        ) {
          context.report({
            node: inner,
            message: `ModelService.models() must expose user-configured runtime models via registry.getModels() + modelEnabled(), not catalog-only source "${inner.property.name}".`,
          })
        }
      })
    } else if (methodName === 'modelEnabled') {
      walkEstree(node.value, (inner) => {
        if (
          inner.type === 'MemberExpression' &&
          !inner.computed &&
          inner.property?.type === 'Identifier' &&
          FORBIDDEN_MODEL_ENABLED_IDENTIFIERS.has(inner.property.name)
        ) {
          context.report({
            node: inner,
            message: `ModelService.modelEnabled() must not filter out models based on catalog source "${inner.property.name}"; Provider Page configured models must stay enabled.`,
          })
        }
      })
    }
  })
}

function checkModelSelector(context, programNode) {
  walkEstree(programNode, (node) => {
    if (
      node.type === 'MemberExpression' &&
      !node.computed &&
      node.property?.type === 'Identifier' &&
      FORBIDDEN_SELECTOR_IDENTIFIERS.has(node.property.name)
    ) {
      context.report({
        node,
        message: `Model selector must display provider-configured models, not raw catalog/discovery source "${node.property.name}".`,
      })
    }
  })
}

const plugin = {
  meta: {
    name: 'pidex-models',
  },
  rules: {
    'preserve-configured-models': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Require the model selector and builtin provider overrides to preserve models added or customized on the Provider Page instead of restricting to catalog lists.',
        },
        schema: [],
      },
      create(context) {
        const filename = normalizeFilename(context.filename)
        if (filename.endsWith(BUILTIN_OVERRIDES_SUFFIX)) {
          return {
            Program(node) {
              checkBuiltinOverrides(context, node)
            },
          }
        }
        if (filename.endsWith(MODEL_SERVICE_SUFFIX)) {
          return {
            Program(node) {
              checkModelService(context, node)
            },
          }
        }
        if (MODEL_SELECTOR_SUFFIXES.some((suffix) => filename.endsWith(suffix))) {
          return {
            Program(node) {
              checkModelSelector(context, node)
            },
          }
        }
        return {}
      },
    },
  },
}

export default plugin
