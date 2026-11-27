function rule(message, listeners) {
  return {
    meta: { type: 'problem', schema: [] },
    create(context) {
      return listeners((node) => context.report({ node, message }), context)
    },
  }
}

function name(node) {
  return node?.name ?? node?.value
}

function callName(node) {
  const callee = node.callee
  return name(callee?.property ?? callee)
}

function contains(node, predicate) {
  if (!node?.type) return false
  if (predicate(node)) return true
  return Object.entries(node).some(
    ([key, value]) =>
      key !== 'parent' &&
      (Array.isArray(value)
        ? value.some((child) => contains(child, predicate))
        : contains(value, predicate)),
  )
}

function calls(node, method) {
  return contains(node, (child) => child.type === 'CallExpression' && callName(child) === method)
}

function member(node, property) {
  return node?.type === 'MemberExpression' && name(node.property) === property
}

function hasGuardBefore(statements, effect, guard) {
  const index = statements.findIndex(effect)
  return index >= 0 && statements.slice(0, index).some(guard)
}

const archive = rule(
  '归档删除须通过专用 RPC，并在删除事务内重读归档状态，跳过已恢复的会话。',
  (report, context) => {
    if (context.filename.endsWith('ThreadHistoryService.ts')) {
      return {
        'MethodDefinition[key.name="remove"]'(node) {
          const valid = contains(node.value.body, (call) => {
            if (call.type !== 'CallExpression' || callName(call) !== 'transaction') return false
            const statements = call.arguments[0]?.body?.body
            if (!Array.isArray(statements)) return false
            const guardIndex = statements.findIndex(
              (statement) =>
                statement.type === 'IfStatement' &&
                statement.test.type === 'LogicalExpression' &&
                statement.test.operator === '&&' &&
                [statement.test.left, statement.test.right].some(
                  (n) =>
                    n.type === 'BinaryExpression' &&
                    n.operator === '===' &&
                    (n.left.value === 'archived' || n.right.value === 'archived'),
                ) &&
                [statement.test.left, statement.test.right].some(
                  (n) =>
                    n.type === 'BinaryExpression' &&
                    n.operator === '<=' &&
                    n.right.value === 0 &&
                    contains(n.left, (part) => member(part, 'archivedAt')),
                ) &&
                contains(
                  statement.consequent,
                  (n) => n.type === 'ReturnStatement' && n.argument?.value === null,
                ),
            )
            const deletesThread = (statement) =>
              contains(
                statement,
                (n) =>
                  (n.type === 'Literal' || n.type === 'TemplateElement') &&
                  /\bdelete\s+from\s+threads\b/i.test(n.value?.cooked ?? n.value),
              )
            return (
              guardIndex >= 0 &&
              statements.slice(0, guardIndex + 1).some((s) => calls(s, 'getListItem')) &&
              hasGuardBefore(statements, deletesThread, (s) => s === statements[guardIndex])
            )
          })
          if (!valid) report(node.key)
        },
      }
    }
    if (context.filename.endsWith('AgentSessionClient.ts')) {
      return {
        'Property[key.name="deleteArchivedSession"]'(node) {
          if (
            !contains(
              node.value,
              (n) =>
                n.type === 'CallExpression' &&
                callName(n) === 'call' &&
                n.arguments[0]?.value === 'thread/deleteArchived',
            ) ||
            contains(node.value, (n) => n.value === 'thread/delete' || member(n, 'disposeSession'))
          )
            report(node.key)
        },
      }
    }
    if (context.filename.endsWith('Thread.ts')) {
      return {
        'SwitchCase[test.value="thread/deleteArchived"] CallExpression[callee.property.name="remove"]'(
          node,
        ) {
          if (node.arguments[1]?.value !== 'archived') report(node)
        },
      }
    }
    return {
      MemberExpression(node) {
        if (member(node, 'disposeSession')) report(node)
      },
      'Literal[value="thread/delete"]': report,
    }
  },
)

const appearance = rule(
  '损坏的外观配置必须保留原件。每次写入前重新检查文件，遇到语法错误时拒绝覆盖。',
  (report) => ({
    CallExpression(node) {
      if (
        ['rm', 'rmSync', 'unlink', 'unlinkSync'].includes(callName(node)) &&
        contains(node.arguments[0], (n) => member(n, 'filePath'))
      )
        report(node)
      if (callName(node) !== 'writeAtomically') return
      const body = node.parent?.parent?.parent?.body
      if (
        !Array.isArray(body) ||
        !hasGuardBefore(
          body,
          (s) => contains(s, (n) => n === node),
          (s) =>
            s.type === 'ExpressionStatement' &&
            s.expression.type === 'AwaitExpression' &&
            callName(s.expression.argument) === 'assertExistingVersionWritable',
        )
      )
        report(node)
    },
    'MethodDefinition[key.name="assertExistingVersionWritable"]'(node) {
      const body = node.value.body
      const checksFile = calls(body, 'readFile') && calls(body, 'parse')
      const rejectsInvalidFile = contains(
        body,
        (n) =>
          n.type === 'CatchClause' &&
          n.body.body.some(
            (s) =>
              s.type === 'IfStatement' &&
              s.test.type === 'UnaryExpression' &&
              s.test.operator === '!' &&
              s.test.argument.type === 'CallExpression' &&
              callName(s.test.argument) === 'isMissingFileError' &&
              contains(s.consequent, (child) => child.type === 'ThrowStatement'),
          ),
      )
      const usesCachedCheck = body.body.some(
        (s) =>
          s.type === 'IfStatement' &&
          contains(s.consequent, (child) => child.type === 'ReturnStatement'),
      )
      if (!checksFile || !rejectsInvalidFile || usesCachedCheck) report(node.key)
    },
  }),
)

const voice = rule('听写快捷键录制和匹配都要先排除普通可打印字符，保留 Shift 输入。', (report) => ({
  FunctionDeclaration(node) {
    if (
      node.id?.name === 'isTypingCharacter' &&
      contains(node.body, (n) => member(n, 'shiftKey'))
    ) {
      report(node.id)
    }
    const recording = node.id?.name === 'formatShortcutFromKeyboardEvent'
    if (!recording && node.id?.name !== 'matchesVoiceShortcut') return
    const rejected = recording ? null : false
    const guard = node.body.body.findIndex(
      (s) =>
        s.type === 'IfStatement' &&
        hasPositiveGuard(s.test, 'isTypingCharacter') &&
        contains(
          s.consequent,
          (n) => n.type === 'ReturnStatement' && n.argument?.value === rejected,
        ),
    )
    if (
      guard === -1 ||
      node.body.body
        .slice(0, guard)
        .some((s) =>
          contains(s, (n) => n.type === 'ReturnStatement' && n.argument?.value !== rejected),
        )
    )
      report(node.id)
  },
}))

function hasPositiveGuard(test, method) {
  if (test.type === 'CallExpression') return callName(test) === method
  return (
    test.type === 'LogicalExpression' &&
    test.operator === '||' &&
    (hasPositiveGuard(test.left, method) || hasPositiveGuard(test.right, method))
  )
}

const bash = rule(
  '桌面终端查找 Git Bash 时要覆盖 PATH 中的 git.exe 和 LOCALAPPDATA 用户安装目录。',
  (report) => ({
    'FunctionDeclaration[id.name="findGitBash"]'(node) {
      const gitLookup = node.body.body
        .flatMap((statement) => statement.declarations ?? [])
        .find(
          (d) =>
            d.init?.type === 'CallExpression' &&
            callName(d.init) === 'findOnPath' &&
            d.init.arguments[0]?.value === 'git.exe',
        )
      const gitOnPath =
        gitLookup &&
        contains(
          node.body,
          (n) =>
            n.type === 'CallExpression' &&
            callName(n) === 'dirname' &&
            n.arguments[0]?.name === gitLookup.id.name,
        )
      const userInstall = contains(
        node.body,
        (n) =>
          n.type === 'CallExpression' &&
          callName(n) === 'join' &&
          member(n.arguments[0], 'LOCALAPPDATA') &&
          n.arguments[1]?.value === 'Programs' &&
          n.arguments[2]?.value === 'Git',
      )
      if (!gitOnPath || !userInstall) report(node.id)
    },
  }),
)

const locale = rule(
  '自动化日期、时间和相对时间须使用界面语言（useLocale），不要依赖系统默认语言或固定地区。',
  (report) => {
    function check(node) {
      const method = callName(node)
      let argument
      if (
        ['DateTimeFormat', 'RelativeTimeFormat'].includes(method) &&
        node.callee.object?.name === 'Intl'
      ) {
        if (
          member(node.parent, 'resolvedOptions') &&
          member(node.parent.parent?.parent, 'timeZone')
        )
          return
        argument = node.arguments[0]
      } else if (['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString'].includes(method)) {
        argument = node.arguments[0]
      } else if (['formatAutomationTime', 'formatAutomationRelativeTime'].includes(method)) {
        argument = node.arguments[1]
      } else return
      if (!argument || argument.type === 'Literal' || argument.name === 'undefined') report(node)
    }
    return { NewExpression: check, CallExpression: check }
  },
)

const provider = rule(
  '模型目录错误只能使用结构化响应状态；通过 response 模式分类，不从说明文字中提取 HTTP 码。',
  (report, context) => ({
    CallExpression(node) {
      if (
        !context.filename.endsWith('ModelHealthService.ts') &&
        ['providerHttpErrorStatus', 'providerFailureCategory'].includes(callName(node)) &&
        node.arguments[1]?.value !== 'response'
      )
        report(node)
    },
    Literal(node) {
      const pattern = node.regex?.pattern
      if (!pattern) return
      const parsesHttpCode = /HTTP/i.test(pattern) && /\\d|\[0-9\]|429/.test(pattern)
      if (context.filename.endsWith('ModelHealthService.ts')) {
        if (
          /\b429\b/.test(pattern) &&
          node.parent?.type === 'MemberExpression' &&
          node.parent.parent?.arguments?.[0]?.name === 'message'
        )
          report(node)
        if (parsesHttpCode) {
          for (let child = node; child.parent; child = child.parent) {
            const parent = child.parent
            if (
              parent.type === 'IfStatement' &&
              parent.consequent === child &&
              sdkMessageOnly(parent.test)
            )
              return
          }
          report(node)
        }
      } else if (parsesHttpCode) report(node)
    },
  }),
)

function sdkMessageOnly(test) {
  if (test.type === 'LogicalExpression' && test.operator === '&&') {
    return sdkMessageOnly(test.left) || sdkMessageOnly(test.right)
  }
  return (
    test.type === 'BinaryExpression' &&
    test.operator === '===' &&
    [test.left, test.right].some((n) => n.name === 'source') &&
    [test.left, test.right].some((n) => n.value === 'sdk-message')
  )
}

export default {
  meta: { name: 'pidex-regressions' },
  rules: {
    'guard-archived-deletion': archive,
    'preserve-corrupt-appearance': appearance,
    'preserve-typing-shortcuts': voice,
    'discover-user-git-bash': bash,
    'use-interface-date-locale': locale,
    'use-response-status': provider,
  },
}
