import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import type { PerformanceSample } from '../../../../scripts/performance/Metrics.js'

const repositoryRoot = resolve(import.meta.dirname, '../../../..')
const electronRoot = resolve(repositoryRoot, 'apps/desktop/electron')
const rendererDist = resolve(repositoryRoot, 'dist/renderer')
const rawDirectory = resolve(repositoryRoot, 'performance-results', 'raw', 'electron')

test.describe('packaged Electron desktop performance', () => {
  test('measures startup, long history, switching, input and sidebar drag', async () => {
    const testInfo = test.info()
    const sample = testInfo.repeatEachIndex + 1
    const root = await mkdtemp(join(tmpdir(), 'pidex-electron-performance-'))
    const userDataDirectory = join(root, 'user-data')
    const dataDirectory = join(root, 'agent-home')
    const logDirectory = join(root, 'logs')
    const metadataPath = join(dataDirectory, 'fixture.json')
    let coldApplication: ElectronApplication | undefined
    let application: ElectronApplication | undefined
    const fatalEvents: string[] = []

    try {
      execFileSync(
        resolveBunExecutable(),
        [
          'run',
          resolve(import.meta.dirname, 'SeedPerformanceDatabase.ts'),
          dataDirectory,
          metadataPath,
        ],
        { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true },
      )
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
        primaryThreadId: string
        threadIds: string[]
      }

      const coldStartedAt = performance.now()
      application = await launchDesktop(userDataDirectory, dataDirectory, logDirectory)
      await application.context().addInitScript(initNewRouteReadinessProbe)
      await attachFatalEventCapture(application)
      let page = await application.firstWindow()
      await page.evaluate(initNewRouteReadinessProbe)
      await setPerformanceWindowSize(application)
      attachPageFatalEventCapture(page, fatalEvents)
      await waitForApplication(page)
      await record('cold-start', sample, {
        readyMs: performance.now() - coldStartedAt,
      })
      await record('new-route-ready', sample, await measureNewRouteReadiness(page))

      fatalEvents.push(...(await readFatalEvents(application)))
      coldApplication = application
      application = undefined
      await quitDesktopWindowOnly(coldApplication)
      const warmStartedAt = performance.now()
      application = await launchDesktop(userDataDirectory, dataDirectory, logDirectory)
      await attachFatalEventCapture(application)
      page = await application.firstWindow()
      await setPerformanceWindowSize(application)
      attachPageFatalEventCapture(page, fatalEvents)
      await waitForApplication(page)
      await waitForThreadCatalog(page)
      await record('warm-start', sample, {
        readyMs: performance.now() - warmStartedAt,
      })

      await openThread(page, metadata.primaryThreadId)
      await loadAllTurns(page)
      const scrollMetrics = await measureScroll(page)
      await record('timeline-scroll', sample, scrollMetrics)

      await record('cold-switch', sample, {
        readyMs: await measureThreadSwitch(page, metadata.threadIds[sample]!, 10),
      })

      await openThread(page, metadata.primaryThreadId)
      await loadAllTurns(page)
      await record('composer-input', sample, {
        inputToPaintP95Ms: await measureComposerInput(page),
      })
      await record('sidebar-dnd', sample, {
        dropReadyMs: await measureSidebarDrop(page),
      })
      await record(
        'memory-stability',
        sample,
        await measureMemoryStability(page, application, metadata.threadIds),
      )

      fatalEvents.push(...(await readFatalEvents(application)))
      fatalEvents.push(...(await readFatalLogEvents(logDirectory)))
      expect(fatalEvents, 'Electron emitted a fatal renderer event').toEqual([])
    } finally {
      if (application) {
        await closeDesktopApplication(application, dataDirectory)
      }
      await terminateBackgroundAgent(dataDirectory)
      if (coldApplication) {
        await closeDesktopApplication(coldApplication, dataDirectory)
      }
      await rm(root, { force: true, recursive: true, maxRetries: 5, retryDelay: 200 })
    }
  })
})

async function launchDesktop(
  userDataDirectory: string,
  dataDirectory: string,
  logDirectory: string,
): Promise<ElectronApplication> {
  const packagedExecutable = process.env.PIDEX_PERF_EXECUTABLE?.trim()
  if (packagedExecutable && !existsSync(packagedExecutable)) {
    throw new Error(`Packaged performance executable not found: ${packagedExecutable}`)
  }
  return electron.launch({
    ...(packagedExecutable
      ? {
          executablePath: resolve(packagedExecutable),
          args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
        }
      : {
          args: [electronRoot, '--enable-precise-memory-info', '--js-flags=--expose-gc'],
        }),
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PIDEX_BUN_PATH: resolveBunExecutable(),
      PIDEX_USER_DATA_DIR: userDataDirectory,
      PIDEX_DATA_DIR: dataDirectory,
      PIDEX_LOG_DIR: logDirectory,
      PIDEX_STATIC_DIR: rendererDist,
      NO_PROXY: '127.0.0.1,localhost,::1',
      no_proxy: '127.0.0.1,localhost,::1',
    },
  })
}

async function attachFatalEventCapture(application: ElectronApplication): Promise<void> {
  await application.evaluate(({ app, BrowserWindow }) => {
    const target = globalThis as typeof globalThis & {
      __pidexPerformanceFatalEvents?: string[]
    }
    target.__pidexPerformanceFatalEvents = []
    app.on('render-process-gone', (_event, _webContents, details) => {
      target.__pidexPerformanceFatalEvents?.push(`render-process-gone:${details.reason}`)
    })
    const register = (window: Electron.BrowserWindow): void => {
      window.on('unresponsive', () => {
        target.__pidexPerformanceFatalEvents?.push('unresponsive')
      })
    }
    for (const window of BrowserWindow.getAllWindows()) register(window)
    app.on('browser-window-created', (_event, window) => register(window))
  })
}

async function setPerformanceWindowSize(application: ElectronApplication): Promise<void> {
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1_600, 1_000)
  })
}

async function readFatalEvents(application: ElectronApplication): Promise<string[]> {
  return application.evaluate(() => {
    const target = globalThis as typeof globalThis & {
      __pidexPerformanceFatalEvents?: string[]
    }
    return [...(target.__pidexPerformanceFatalEvents ?? [])]
  })
}

function attachPageFatalEventCapture(page: Page, fatalEvents: string[]): void {
  page.on('crash', () => fatalEvents.push('page-crash'))
  page.on('pageerror', (error) => {
    fatalEvents.push(`page-error:${error.name}`)
  })
}

async function waitForApplication(page: Page): Promise<void> {
  await page.waitForURL(/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\//, {
    timeout: 60_000,
  })
  await expect(page.locator('html')).toHaveAttribute('data-window-type', 'electron')
  // 真实 ProseMirror 编辑器才可输入；Suspense fallback 也带
  // .composer-editor-content 但不能输入。Agent sidecar 冷启动可能较慢，
  // 给真实编辑器出现留出与 waitForURL 一致的等待窗口。
  await page
    .locator('.composer-editor-content[contenteditable="true"][role="combobox"]')
    .waitFor({ timeout: 60_000 })
}

type NewRouteReadinessProbe = {
  composerReadyAt: number | null
  completeAt: number | null
  jsDecodedBytes: number
  jsResourceCount: number
  cssDecodedBytes: number
}

// 在同一次 cold start 中观测 /new 真实可交互时间：composerReadyMs 是
// Renderer navigationStart 到真实 ProseMirror 编辑器可输入；completeReadyMs
// 再等待当前 coding/working/chat surface 的根内容、字体与连续两个
// animation frame；jsDecodedBytes/jsResourceCount/cssDecodedBytes
// 在 complete checkpoint 时采样同源资源。本轮仅观测，不设硬预算。
function initNewRouteReadinessProbe(): void {
  const target = globalThis as typeof globalThis & {
    __pidexNewRouteReadiness?: {
      composerReadyAt: number | null
      completeAt: number | null
      jsDecodedBytes: number
      jsResourceCount: number
      cssDecodedBytes: number
    }
  }
  if (target.__pidexNewRouteReadiness) return
  const probe = {
    composerReadyAt: null as number | null,
    completeAt: null as number | null,
    jsDecodedBytes: 0,
    jsResourceCount: 0,
    cssDecodedBytes: 0,
  }
  target.__pidexNewRouteReadiness = probe

  const composerSelector = '.composer-editor-content[contenteditable="true"][role="combobox"]'
  const surfaceReadySelector = [
    '.quick-chat-view',
    '.new-session-suggestions.is-root',
    '.working-suggestions',
    '.chat-home-view',
  ].join(',')
  let completeTimer: ReturnType<typeof setInterval> | null = null
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null
  let observer: MutationObserver | null = null
  const complete = (): void => {
    if (probe.completeAt !== null) return
    if (completeTimer !== null) clearInterval(completeTimer)
    if (fallbackTimer !== null) clearTimeout(fallbackTimer)
    observer?.disconnect()
    probe.completeAt = performance.now()
    const sameOrigin = (entry: PerformanceResourceTiming): boolean => {
      try {
        return new URL(entry.name, location.href).origin === location.origin
      } catch {
        return false
      }
    }
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    const resourcePath = (entry: PerformanceResourceTiming): string => {
      try {
        return new URL(entry.name, location.href).pathname.toLowerCase()
      } catch {
        return ''
      }
    }
    // ES module/dynamic-import initiatorType differs between Chromium
    // versions. Classify same-origin built assets by pathname instead.
    const scripts = resources.filter(
      (entry) => sameOrigin(entry) && resourcePath(entry).endsWith('.js'),
    )
    const stylesheets = resources.filter(
      (entry) => sameOrigin(entry) && resourcePath(entry).endsWith('.css'),
    )
    probe.jsDecodedBytes = scripts.reduce((total, entry) => total + entry.decodedBodySize, 0)
    probe.jsResourceCount = scripts.length
    probe.cssDecodedBytes = stylesheets.reduce((total, entry) => total + entry.decodedBodySize, 0)
  }
  const waitForComplete = (): void => {
    if (completeTimer !== null) return
    const check = (): void => {
      if (!document.querySelector(surfaceReadySelector)) return
      void document.fonts.ready.then(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => complete())
        })
      })
    }
    completeTimer = window.setInterval(check, 50)
    // 兜底：composer 就绪后 5s 内必须完成，避免字体等异常阻塞样本
    fallbackTimer = window.setTimeout(() => complete(), 5_000)
    check()
  }
  const markComposerReady = (): void => {
    if (probe.composerReadyAt !== null) return
    probe.composerReadyAt = performance.now()
    waitForComplete()
  }
  observer = new MutationObserver(() => {
    if (document.querySelector(composerSelector)) markComposerReady()
  })
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['contenteditable', 'role'],
  })
  if (document.querySelector(composerSelector)) markComposerReady()
}

async function measureNewRouteReadiness(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const probe = (
      globalThis as typeof globalThis & {
        __pidexNewRouteReadiness?: NewRouteReadinessProbe
      }
    ).__pidexNewRouteReadiness
    if (!probe) {
      throw new Error('Missing /new readiness probe in renderer navigation.')
    }
    return new Promise((resolve, reject) => {
      const startedAt = Date.now()
      const poll = (): void => {
        if (probe.completeAt !== null) {
          resolve({
            composerReadyMs: probe.composerReadyAt ?? -1,
            completeReadyMs: probe.completeAt,
            jsDecodedBytes: probe.jsDecodedBytes,
            jsResourceCount: probe.jsResourceCount,
            cssDecodedBytes: probe.cssDecodedBytes,
          })
          return
        }
        if (Date.now() - startedAt > 10_000) {
          reject(new Error('Timed out waiting for /new readiness probe completion.'))
          return
        }
        window.setTimeout(poll, 50)
      }
      poll()
    })
  })
}

async function waitForThreadCatalog(page: Page): Promise<void> {
  const recentSection = page.locator('[data-sidebar-section-id="recent"]')
  await recentSection.waitFor()
  if ((await recentSection.getAttribute('aria-expanded')) !== 'true') {
    await recentSection.click()
  }
  await page.locator('.sidebar-session-row').first().waitFor({
    timeout: 60_000,
  })
}

async function openThread(page: Page, threadId: string, expectedTurns?: number): Promise<void> {
  await page.evaluate((id) => {
    location.hash = `#/threads/${encodeURIComponent(id)}`
  }, threadId)
  await page.locator(`[data-canonical-thread-id="${threadId}"]`).waitFor()
  if (expectedTurns !== undefined) {
    await page
      .locator(
        `[data-canonical-thread-id="${threadId}"][data-canonical-turn-count="${expectedTurns}"]`,
      )
      .waitFor()
  }
}

async function loadAllTurns(page: Page): Promise<void> {
  const loadOlder = page.getByRole('button', { name: '加载更早的对话' })
  const threadView = page.locator('.canonical-thread-view')
  const readTurnCount = async (): Promise<number> =>
    Number((await threadView.getAttribute('data-canonical-turn-count')) ?? '0')
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if ((await readTurnCount()) >= 500 && (await loadOlder.count()) === 0) break
    if (
      (await loadOlder.isVisible().catch(() => false)) &&
      (await loadOlder.isEnabled().catch(() => false))
    ) {
      await loadOlder.click().catch(() => undefined)
    }
    await page.waitForTimeout(100)
  }
  await expect(loadOlder).toBeHidden()
  await expect.poll(readTurnCount).toBe(500)
}

async function measureScroll(page: Page): Promise<Record<string, number>> {
  return page.locator('.workflow-main-scroll-area').evaluate(async (element) => {
    const scroll = async (): Promise<void> => {
      for (let step = 0; step < 100; step += 1) {
        element.scrollTop = (step / 99) * Math.max(0, element.scrollHeight - element.clientHeight)
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }
    }
    await scroll()
    const frameGaps: number[] = []
    const longTasks: number[] = []
    let lastFrame = performance.now()
    let animationFrame = 0
    const frame = (now: number): void => {
      frameGaps.push(now - lastFrame)
      lastFrame = now
      animationFrame = requestAnimationFrame(frame)
    }
    animationFrame = requestAnimationFrame(frame)
    const observer = PerformanceObserver.supportedEntryTypes.includes('longtask')
      ? new PerformanceObserver((entries) => {
          for (const entry of entries.getEntries()) longTasks.push(entry.duration)
        })
      : null
    observer?.observe({ entryTypes: ['longtask'] })
    await scroll()
    cancelAnimationFrame(animationFrame)
    observer?.disconnect()
    frameGaps.sort((left, right) => left - right)
    return {
      frameP95Ms: frameGaps[Math.max(0, Math.ceil(frameGaps.length * 0.95) - 1)] ?? 0,
      maxLongTaskMs: Math.max(0, ...longTasks),
    }
  })
}

async function measureComposerInput(page: Page): Promise<number> {
  const editor = page.locator('.composer-editor-content')
  await editor.click()
  const values: number[] = []
  for (const character of 'Pidex-electron-input-response-0123456789-abcdefghij') {
    await page.evaluate(() => {
      const target = window as typeof window & {
        __pidexInputPaint?: Promise<number>
      }
      target.__pidexInputPaint = new Promise((resolve) => {
        document.addEventListener(
          'input',
          () => {
            const startedAt = performance.now()
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolve(performance.now() - startedAt)),
            )
          },
          { capture: true, once: true },
        )
      })
    })
    await page.keyboard.type(character)
    values.push(
      await page.evaluate(() => {
        const target = window as typeof window & {
          __pidexInputPaint?: Promise<number>
        }
        return target.__pidexInputPaint
      }),
    )
  }
  values.sort((left, right) => left - right)
  return values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? 0
}

async function measureSidebarDrop(page: Page): Promise<number> {
  const recentSection = page.locator('[data-sidebar-section-id="recent"]')
  if ((await recentSection.getAttribute('aria-expanded')) !== 'true') {
    await recentSection.click()
  }
  const rows = page.locator('.sidebar-session-row')
  const showMore = page.getByRole('button', { name: '展开显示' })
  while ((await rows.count()) < 100 && (await showMore.count()) > 0) {
    await showMore.first().click()
  }
  await expect(rows.first()).toBeVisible()
  if ((await rows.count()) !== 100) {
    throw new Error(`Expected 100 sidebar session rows, received ${await rows.count()}`)
  }
  const source = rows.nth(0)
  const target = rows.nth(1)
  await source.scrollIntoViewIfNeeded()
  await target.scrollIntoViewIfNeeded()
  const [sourceBox, targetBox] = await Promise.all([source.boundingBox(), target.boundingBox()])
  if (!sourceBox || !targetBox) {
    throw new Error('Sidebar reorder rows have no bounds')
  }
  const sourceId = await source.getAttribute('data-sidebar-session-id')
  const draggedRow = page.locator(`[data-sidebar-session-id="${sourceId}"]`)
  const orderBefore = await draggedRow.locator('..').innerText()
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.evaluate(() => {
    const targetWindow = window as typeof window & {
      __pidexElectronDropReady?: Promise<number>
    }
    targetWindow.__pidexElectronDropReady = new Promise((resolve) => {
      document.addEventListener(
        'pointerup',
        () => {
          const droppedAt = performance.now()
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve(performance.now() - droppedAt)),
          )
        },
        { capture: true, once: true },
      )
    })
  })
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height, {
    steps: 8,
  })
  await expect(draggedRow).toHaveAttribute('data-dragging', 'true')
  await page.mouse.up()
  await expect(draggedRow.locator('..')).not.toHaveText(orderBefore)
  return page.evaluate(() => {
    const targetWindow = window as typeof window & {
      __pidexElectronDropReady?: Promise<number>
    }
    if (!targetWindow.__pidexElectronDropReady) {
      throw new Error('Missing Electron sidebar drop measurement promise')
    }
    return targetWindow.__pidexElectronDropReady
  })
}

async function measureMemoryStability(
  page: Page,
  application: ElectronApplication,
  threadIds: readonly string[],
): Promise<Record<string, number>> {
  const before = await memorySnapshot(page, application)
  for (const threadId of threadIds.slice(0, 100)) {
    await openThread(page, threadId)
  }
  const after = await memorySnapshot(page, application)
  const heapDelta = after.heap - before.heap
  const rssDelta = after.rss - before.rss
  const heapDeltaPercent = (heapDelta / Math.max(1, before.heap)) * 100
  const rssDeltaPercent = (rssDelta / Math.max(1, before.rss)) * 100
  return {
    heapDeltaMiB: heapDelta / 1024 / 1024,
    heapDeltaPercent,
    memoryRegressionScore:
      heapDeltaPercent > 25 &&
      rssDeltaPercent > 25 &&
      Math.max(heapDelta, rssDelta) > 128 * 1024 * 1024
        ? 1
        : 0,
    rssDeltaMiB: rssDelta / 1024 / 1024,
    rssDeltaPercent,
  }
}

async function measureThreadSwitch(
  page: Page,
  threadId: string,
  expectedTurns: number,
): Promise<number> {
  return page.evaluate(
    async ({ expected, id }) => {
      const startedAt = performance.now()
      location.hash = `#/threads/${encodeURIComponent(id)}`
      while (performance.now() - startedAt < 60_000) {
        if (
          document.querySelector<HTMLElement>(`[data-canonical-thread-id="${id}"]`)?.dataset
            .canonicalTurnCount === String(expected)
        ) {
          return performance.now() - startedAt
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }
      throw new Error(`Electron thread ${id} did not become ready`)
    },
    { expected: expectedTurns, id: threadId },
  )
}

async function readFatalLogEvents(logDirectory: string): Promise<string[]> {
  if (!existsSync(logDirectory)) return []
  const entries = await readdir(logDirectory, { withFileTypes: true })
  const events: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const contents = await readFile(join(logDirectory, entry.name), 'utf8')
    const hasUnexpectedReconnect = contents
      .split(/\r?\n/)
      .some(
        (line) =>
          line.includes('desktop.connection-lost') ||
          (line.includes('"phase":"reconnecting"') && !line.includes('"lifecycle":"disposing"')),
      )
    if (hasUnexpectedReconnect) {
      events.push('sidecar-reconnect')
      break
    }
  }
  return events
}

async function memorySnapshot(
  page: Page,
  application: ElectronApplication,
): Promise<{ heap: number; rss: number }> {
  const heap = await page.evaluate(async () => {
    ;(globalThis as typeof globalThis & { gc?: () => void }).gc?.()
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    return (
      (
        performance as Performance & {
          memory?: { usedJSHeapSize: number }
        }
      ).memory?.usedJSHeapSize ?? 0
    )
  })
  const rss = await application.evaluate(() => process.memoryUsage().rss)
  return { heap, rss }
}

async function record(
  scenario: string,
  sample: number,
  metrics: Record<string, number>,
): Promise<void> {
  const batch = Math.max(1, Number.parseInt(process.env.PIDEX_PERF_BATCH ?? '1', 10) || 1)
  const value: PerformanceSample = {
    batch,
    environment: {
      cpuCount: process.env.NUMBER_OF_PROCESSORS ?? null,
      executable: process.env.PIDEX_PERF_EXECUTABLE ? '<packaged>' : '<dev>',
      platform: process.platform,
    },
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([key, metric]) => [key, Number(metric.toFixed(3))]),
    ),
    sample,
    scenario,
    suite: 'electron',
    timestamp: new Date().toISOString(),
  }
  await mkdir(rawDirectory, { recursive: true })
  await writeFile(
    resolve(rawDirectory, `${scenario}-b${batch}-s${sample}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  )
}

function resolveBunExecutable(): string {
  if (process.env.PIDEX_BUN_PATH) return process.env.PIDEX_BUN_PATH
  const output = execFileSync('where.exe', ['bun'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const commandPaths = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const executable = [
    ...commandPaths.filter((path) => path.toLowerCase().endsWith('.exe')),
    ...commandPaths.map((path) => join(dirname(path), 'node_modules/bun/bin/bun.exe')),
  ].find((path) => existsSync(path))
  if (!executable) throw new Error('Electron performance test did not find bun.exe')
  return executable
}

async function quitDesktopWindowOnly(application: ElectronApplication): Promise<void> {
  const proc = application.process()
  const exitPromise =
    !proc || proc.exitCode !== null || proc.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolveExit) => {
          proc.once('exit', () => resolveExit())
        })
  await runWithTimeout(
    application.evaluate(({ app }) => app.quit()).catch(() => undefined),
    10_000,
  )
  await runWithTimeout(exitPromise, 15_000)
}

async function closeDesktopApplication(
  application: ElectronApplication,
  dataDirectory: string,
): Promise<void> {
  await runWithTimeout(
    application
      .evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (window) {
          await window.webContents.executeJavaScript('window.DesktopBridge?.stopBackendAndExit?.()')
        }
      })
      .catch(() => undefined),
    15_000,
  )
  const closedInTime = await runWithTimeout(
    application
      .close()
      .then(() => true)
      .catch(() => true),
    20_000,
  )
  if (closedInTime) return
  await terminateBackgroundAgent(dataDirectory)
  const pid = application.process()?.pid
  if (pid) killProcessTree(pid)
  await runWithTimeout(
    application.close().catch(() => undefined),
    5_000,
  )
}

async function terminateBackgroundAgent(dataDirectory: string): Promise<void> {
  const runtimeFile = join(dataDirectory, 'runtime', 'desktop-agent.json')
  try {
    const record = JSON.parse(await readFile(runtimeFile, 'utf8')) as { pid?: unknown }
    if (typeof record.pid === 'number' && Number.isSafeInteger(record.pid) && record.pid > 0) {
      killProcessTree(record.pid)
    }
  } catch {
    // Runtime descriptor may not exist yet or may already be removed.
  }
}

function killProcessTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    // Process may have already exited.
  }
}

async function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(undefined), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
