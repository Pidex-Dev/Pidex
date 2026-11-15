import { expect, test, type Locator, type Page } from '@playwright/test'
import { DESKTOP_VIEWPORT, prepareVisualTheme, waitForVisualPage } from './VisualTestHelpers.js'

const COLD_BOOT_TIMEOUT_MS = 25_000

function trackPageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => {
    errors.push(error.message)
  })
  return errors
}

async function openVisualRoute(
  page: Page,
  route: string,
  readyLocator: Locator,
  mode: 'dark' | 'light' = 'dark',
): Promise<string[]> {
  const errors = trackPageErrors(page)
  await page.setViewportSize(DESKTOP_VIEWPORT)
  await prepareVisualTheme(page, mode)
  await page.goto(route)
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode, {
    timeout: COLD_BOOT_TIMEOUT_MS,
  })
  const laterButton = page.getByRole('button', { name: '稍后', exact: true })
  if (await laterButton.isVisible().catch(() => false)) {
    await laterButton.click()
  }
  await waitForVisualPage(page, mode)
  await expect(readyLocator).toBeVisible({ timeout: 15_000 })
  return errors
}

test('@feature:thread-lifecycle new conversation and canonical thread routes render', async ({
  page,
}) => {
  const errors = await openVisualRoute(
    page,
    '/?visualCase=rich&visualModelPicker=1#/new?surface=coding',
    page.locator('.coding-chat-view'),
  )
  await expect(page.locator('.coding-chat-view .composer-input-surface')).toBeVisible()

  await page.goto('/?visualCase=rich&visualModelPicker=1#/threads/visual-rich')
  await expect(page.locator('.conversation-page')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('已完成工作台结构梳理。', { exact: true })).toBeVisible({
    timeout: 15_000,
  })
  expect(errors).toEqual([])
})

test('@feature:projects-workspace projects route renders workspace inventory', async ({ page }) => {
  const errors = await openVisualRoute(
    page,
    '/?visualCase=rich&visualModelPicker=1#/projects',
    page.locator('.projects-primary-page'),
  )
  await expect(page.getByRole('heading', { name: '项目', level: 1 })).toBeVisible()
  await expect(page.locator('.environment-settings')).toBeVisible()
  expect(errors).toEqual([])
})

test('@feature:worktree-git git board route renders repository view', async ({ page }) => {
  const errors = await openVisualRoute(
    page,
    '/?visualCase=rich&visualModelPicker=1#/git',
    page.getByRole('heading', { name: 'Git 看板', level: 1 }),
  )
  await expect(page.getByText('从左侧选择一个项目查看 Git 状态', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('@feature:github-pull-requests pull-requests route renders placeholder and new thread action', async ({
  page,
}) => {
  const errors = await openVisualRoute(
    page,
    '/?visualCase=rich&visualModelPicker=1#/pull-requests',
    page.locator('.pull-requests-placeholder'),
  )
  await expect(page.getByRole('heading', { name: '拉取请求', level: 1 })).toBeVisible()
  await expect(
    page.getByRole('heading', { name: '拉取请求收件箱正在开发中', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: '新建对话', exact: true })).toHaveAttribute(
    'href',
    '#/new',
  )
  expect(errors).toEqual([])
})

test('@feature:models-catalog providers and setup routes render model management surfaces', async ({
  page,
}) => {
  const errors = await openVisualRoute(
    page,
    '/?visualCase=rich&visualModelPicker=1#/providers',
    page.locator('.model-center-shell'),
  )
  await page.goto('/?visualCase=empty#/setup')
  await expect(page.locator('.model-setup-main')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('heading', { name: '先连接一个模型供应商', level: 1 })).toBeVisible()
  expect(errors).toEqual([])
})

test('@feature:local-environment environment settings route redirects with projectId', async ({
  page,
}) => {
  const errors = await openVisualRoute(
    page,
    '/?visualCase=rich&visualModelPicker=1#/settings/environment/demo-project',
    page
      .getByRole('region', { name: '主要内容' })
      .getByRole('heading', { name: '选择项目', exact: true }),
  )
  await expect(page).toHaveURL(/#\/settings\/environments\?projectId=demo-project/u)
  expect(errors).toEqual([])
})

test('@feature:workflows-session-groups workflows route renders session groups view', async ({
  page,
}) => {
  const errors = await openVisualRoute(
    page,
    '/?visualCase=rich&visualModelPicker=1#/workflows',
    page.getByRole('heading', { name: '工作组', level: 1 }),
  )
  await expect(page.locator('.session-groups-index')).toBeVisible()
  expect(errors).toEqual([])
})

test('@feature:automation-schedule automations route renders calendar and schedule surface', async ({
  page,
}) => {
  const errors = await openVisualRoute(
    page,
    '/?visualCase=rich&visualModelPicker=1#/automations',
    page.locator('.automation-view'),
  )
  await expect(page.getByRole('heading', { name: '任务日历', level: 1 })).toBeVisible()
  expect(errors).toEqual([])
})

test('@feature:browser-computer browser settings route renders site permissions and download controls', async ({
  page,
}) => {
  const errors = await openVisualRoute(
    page,
    '/?visualCase=rich&visualModelPicker=1#/settings/browser',
    page.getByRole('heading', { name: '浏览器', exact: true }),
  )
  await expect(page.getByRole('heading', { name: '站点权限', exact: true })).toBeVisible()
  await expect(page.getByRole('switch', { name: '每次询问保存位置', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('@feature:plugins-skills-mcp plugins route renders catalog and seeded plugin', async ({
  page,
}) => {
  const errors = await openVisualRoute(
    page,
    '/?visualCase=rich&visualModelPicker=1#/plugins',
    page.getByRole('heading', { name: '插件', level: 1 }),
  )
  await expect(page.getByRole('searchbox', { name: '搜索插件' })).toBeVisible()
  await expect(page.getByText('任务规划', { exact: true }).first()).toBeVisible()
  expect(errors).toEqual([])
})

test('@feature:pet-companion pets catalog and overlay routes render cleanly', async ({ page }) => {
  const errors = await openVisualRoute(
    page,
    '/?visualCase=rich&visualModelPicker=1#/pets',
    page.locator('.pet-catalog-primary-page'),
  )
  await expect(page.getByRole('heading', { name: '宠物', level: 1 })).toBeVisible()
  await page.goto('/?visualCase=rich&visualModelPicker=1#/pet-overlay')
  await expect(page.locator('.pet-overlay-page')).toBeVisible({ timeout: 15_000 })
  expect(errors).toEqual([])
})
