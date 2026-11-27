function rule(create) {
  return { meta: { type: 'problem', schema: [] }, create }
}

const retiredDesktopMembers = new Set([
  'getAuthStatus',
  'getRuntimeStatus',
  'diagnoseDesktopToolchain',
  'reinstallDesktopToolchain',
  'deleteDesktopToolchain',
  'getCopilotAuthStatus',
  'startCopilotLogin',
  'pollCopilotLogin',
  'cancelCopilotLogin',
  'listDebugBuiltinTools',
  'runDebugToolProbe',
  'cancelDebugToolProbe',
  'exportUserMemory',
  'importUserMemory',
  'openDevTools',
  'closeDevTools',
  'onAgentEvent',
  'onWorkflowEvent',
  'onUiCommand',
])

function inMissingFileBranch(node) {
  for (let child = node; child.parent; child = child.parent) {
    const parent = child.parent
    if (parent.type !== 'IfStatement' || parent.consequent !== child) continue
    const test = parent.test
    if (test.type === 'CallExpression' && test.callee.name === 'isMissingFileError') {
      return true
    }
  }
  return false
}

export default {
  meta: { name: 'pidex-compat' },
  rules: {
    'no-retired-desktop-member': rule((context) => {
      function check(node) {
        const name = node.name ?? node.value
        if (retiredDesktopMembers.has(name)) {
          context.report({
            node,
            message: `The private desktop client member ${name} has been retired.`,
          })
        }
      }
      return {
        'TSMethodSignature, TSPropertySignature, Property, MethodDefinition'(node) {
          check(node.key)
        },
        'ArrayExpression > Literal, CallExpression[callee.name="lazyMock"] > Literal': check,
      }
    }),
    'no-retired-appearance-channel': rule((context) => ({
      'Literal[value="appearance:settings:changed"], TemplateElement[value.cooked="appearance:settings:changed"]'(
        node,
      ) {
        context.report({ node, message: 'The appearance settings broadcast has been retired.' })
      },
    })),
    'no-retired-agent-entry': rule((context) => ({
      MethodDefinition(node) {
        const owner = node.parent.parent.id?.name
        const method = node.key.name ?? node.key.value
        if (
          (owner === 'ProjectRepositoryDatabase' &&
            (method === 'removeProjectRecord' || method === 'requireProjectForRemoval')) ||
          (owner === 'ProjectSourceService' && method === 'removeAll')
        ) {
          context.report({
            node: node.key,
            message: 'Use the reversible ProjectService removal flow.',
          })
        } else if (owner === 'ExecutionRepositoryDatabase' && method === 'takeGuideMailbox') {
          context.report({
            node: node.key,
            message: 'Read guideMailbox and acknowledge delivered IDs with the session write.',
          })
        } else if (owner === 'ModelService' && method === 'discoverModels') {
          context.report({
            node: node.key,
            message: 'Use the existing provider/model/discover dispatch.',
          })
        }
      },
    })),
    'builtin-migration-schema': rule((context) => {
      const builtin =
        ':matches(VariableDeclarator[id.name="migrateBuiltin"], FunctionDeclaration[id.name="migrateBuiltin"])'
      return {
        [`${builtin} CallExpression[callee.name="unsupportedKeys"]`](node) {
          const keys = node.arguments[1]?.name
          if (keys === 'BUILTIN_PROVIDER_CONFIG_KEYS' || keys === 'BUILTIN_MODEL_CONFIG_KEYS')
            return
          context.report({
            node,
            message: 'Validate builtin overrides with the key sets from ProviderConfig.',
          })
        },
        [`${builtin} BinaryExpression[operator="!="], ${builtin} BinaryExpression[operator="!=="]`](
          node,
        ) {
          if (node.left.value === 'enabled' || node.right.value === 'enabled') {
            context.report({
              node,
              message: 'Validate the full builtin model schema before disabling its provider.',
            })
          }
        },
      }
    }),
    'data-location-default-on-enoent': rule((context) => ({
      ObjectExpression(node) {
        const emptyLocation = node.properties.some(
          (property) =>
            (property.key?.name ?? property.key?.value) === 'activeDataDir' &&
            property.value?.value === null,
        )
        if (emptyLocation && !inMissingFileBranch(node)) {
          context.report({
            node,
            message: 'Only a missing data-location.json may initialize the default bootstrap.',
          })
        }
      },
    })),
    'no-retired-desktop-bridge': rule((context) => {
      function report(node) {
        context.report({
          node,
          message:
            'This desktop bridge has been retired. Use the typed preload and shared IPC contracts.',
        })
      }
      if (/[\\/]shared[\\/](?:IpcChannels|DesktopBridgeArgs)\.ts$/.test(context.filename)) {
        return { Program: report }
      }
      return {
        'Literal[value="__desktopBrowserDebugUndefined"]': report,
        TemplateLiteral(node) {
          if (
            node.expressions.length === 1 &&
            node.quasis[0].value.cooked === 'desktop:' &&
            node.quasis[1].value.cooked === ''
          )
            report(node)
        },
      }
    }),
  },
}
