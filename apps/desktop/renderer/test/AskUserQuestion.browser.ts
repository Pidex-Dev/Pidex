// Run: bun apps/desktop/renderer/test/AskUserQuestion.browser.ts
import { strict as assert } from 'node:assert'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { chromium, expect } from '@playwright/test'
import { compileEntryStyles } from './helpers/RendererStyles.ts'

const rendererRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string) =>
  JSON.stringify(resolve(rendererRoot, 'src', path).replaceAll('\\', '/'))
const harness = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AskUserQuestionApproval } from ${source('features/session/approvals/AskUserQuestionApproval.tsx')};
import { PlanApprovalCard } from ${source('features/session/approvals/PlanApprovalCard.tsx')};
import { InlineApprovalCard } from ${source('features/session/approvals/InlineApprovalCard.tsx')};
import { ButtonStyles } from ${source('components/ui/Button.tsx')};
import { reconcileQuestionDrafts } from ${source('features/session/approvals/AskUserQuestionModel.ts')};
import { deriveThemeVariables } from ${source('features/theme/ThemeVariables.ts')};
import { DEFAULT_LIGHT_THEME, DEFAULT_DARK_THEME } from ${source('../shared/Theme.ts')};
document.documentElement.dataset.theme = 'light';
Object.entries(deriveThemeVariables(DEFAULT_LIGHT_THEME)).forEach(([key,value])=>document.documentElement.style.setProperty(key,value));

const questions = [
  { id: 'scope', header: '范围', question: '计划应覆盖哪些客户端？', options: [
      { id: 'desktop', label: '仅桌面端', description: '本次集中完成桌面交互。', recommended: true },
      { id: 'both', label: '桌面端与 CLI', description: '同时设计共享能力和两端入口。' },
    ], multiSelect: false },
  { id: 'phase', header: '阶段', question: '先完成哪一部分？', options: [
      { id: 'ask', label: '提问交互', description: '先把逐题确认做扎实。' }, { id: 'dock', label: '计划侧栏' },
    ], multiSelect: false },
  { id: 'extra', header: '补充', question: '还有其他约束吗？', options: [
      { id: 'none', label: '暂时没有' }, { id: 'later', label: '稍后补充' },
    ], multiSelect: false },
];
const textQuestion = { id: 'free', header: '补充', question: '还有其他约束吗？', options: [], multiSelect: false };
const planApproval = { id: 'approval-1', threadId: 'thread-1', turnId: 'turn-1', planItemId: 'turn-1:plan', version: 1, status: 'pending', title: 'Plan 流程与交互重设计', markdown: '# 计划', nextTurnId: null, createdAt: 1, resolvedAt: null };

function resetState(){
  window.submissions=[]; window.rejects=0; window.interrupts=0; window.responses=[];
  window.openedPlans=[]; window.ownerActions=[]; window.decisions=[];
  window.asyncSubmission=false; window.asyncResponse=false;
}
window.ownerActions=[];

function Harness(){
  const [mode,setMode]=useState('question');
  const [generation,setGeneration]=useState(0);
  const [interrupted,setInterrupted]=useState(false);
  const [multi,setMulti]=useState(false);
  const [supportsSkip,setSupportsSkip]=useState(true);
  const [planThread,setPlanThread]=useState('thread-plan');
  const go=(next)=>{ resetState(); setInterrupted(false); setMulti(false); setSupportsSkip(true); setPlanThread('thread-plan'); setMode(next); setGeneration(x=>x+1); };
  const submit=(input)=>{ window.submissions.push(input); if(window.asyncSubmission) return new Promise((resolve,reject)=>{ window.resolveSubmission=resolve; window.rejectSubmission=reject; }); };
  const reject=()=>{ window.rejects+=1; };
  const interrupt=()=>{ window.interrupts+=1; return new Promise((resolve,reject)=>{ window.resolveInterrupt=()=>{ setInterrupted(true); resolve(); }; window.rejectInterrupt=reject; }); };
  const questionInput=(threadId, list)=>({ threadId, version: 1, questions: list });
  return <main style={{width:900,margin:'80px auto'}}>
    <ButtonStyles />
    <div>
      <button onClick={()=>go('question')}>聊天提问</button>
      <button onClick={()=>go('single')}>单题提问</button>
      <button onClick={()=>go('plan')}>计划提问</button>
      <button onClick={()=>{ const target = planThread==='thread-plan' ? 'thread-plan-b' : 'thread-plan'; reconcileQuestionDrafts(target, new Set([target+':plan-'+generation+':1'])); setPlanThread(target); }}>切换聊天</button>
      <button onClick={()=>go('planText')}>纯文本计划题</button>
      <button onClick={()=>go('approval')}>计划审批</button>
      <button onClick={()=>go('approvalFresh')}>计划审批-新聊天能力</button>
      <button onClick={()=>go('twins')}>并排问题</button>
      <button onClick={()=>go('permission')}>权限</button>
      <button onClick={()=>go('grant')}>授权范围</button>
      <button onClick={()=>{setMulti(m=>!m); setGeneration(x=>x+1)}}>多选</button>
      <button onClick={()=>setSupportsSkip(x=>!x)}>切换跳过能力</button>
      <button onClick={()=>{ document.documentElement.dataset.theme='dark'; Object.entries(deriveThemeVariables(DEFAULT_DARK_THEME)).forEach(([k,v])=>document.documentElement.style.setProperty(k,v)) }}>深色</button>
      <button onClick={()=>{ document.documentElement.dataset.theme='light'; Object.entries(deriveThemeVariables(DEFAULT_LIGHT_THEME)).forEach(([k,v])=>document.documentElement.style.setProperty(k,v)) }}>浅色</button>
    </div>
    {interrupted ? <p>对话已中断</p>
    : mode==='question' ? <AskUserQuestionApproval key={generation} supportsQuestionSkip={supportsSkip}
        request={{requestId:'ask-'+generation,toolName:'AskUserQuestion',description:'请选择',input:questionInput('thread-ask', questions.map((q,i)=>({...q,multiSelect:multi&&i===0})))}}
        onSubmit={submit} onReject={reject} onInterrupt={interrupt} />
    : mode==='single' ? <AskUserQuestionApproval key={'single-'+generation} supportsQuestionSkip={supportsSkip}
        request={{requestId:'single-'+generation,toolName:'AskUserQuestion',description:'请选择',input:questionInput('thread-single', [questions[0]])}}
        onSubmit={submit} onReject={reject} onInterrupt={interrupt} />
    : mode==='plan' ? <AskUserQuestionApproval key={'plan-'+generation+':'+planThread} taskMode="plan"
        request={{requestId:'plan-'+generation,toolName:'AskUserQuestion',description:'请选择',input:questionInput(planThread, questions)}}
        onSubmit={submit} onReject={reject} onInterrupt={interrupt} />
    : mode==='planText' ? <AskUserQuestionApproval key={generation} taskMode="plan"
        request={{requestId:'plantext-'+generation,toolName:'AskUserQuestion',description:'请选择',input:questionInput('thread-plantext', [textQuestion])}}
        onSubmit={submit} onReject={reject} onInterrupt={interrupt} />
    : mode==='approval'||mode==='approvalFresh' ? <PlanApprovalCard key={generation} approval={planApproval} freshAvailable={mode==='approvalFresh'}
        onRespond={async (response)=>{ window.responses.push(response); if(window.asyncResponse) return new Promise((resolve,reject)=>{ window.resolveResponse=resolve; window.rejectResponse=reject; }); }}
        onOpenPlan={(plan)=>window.openedPlans.push(plan)} />
    : mode==='twins' ? [0,1].map(owner=><div data-owner={owner} key={owner}>
        <AskUserQuestionApproval supportsQuestionSkip request={{requestId:'owner-'+owner,toolName:'AskUserQuestion',description:'请选择',input:questionInput('thread-owner-'+owner, questions)}} onSubmit={()=>{}} onReject={()=>{window.ownerActions.push(owner)}} />
      </div>)
    : mode==='permission'||mode==='grant' ? <InlineApprovalCard key={generation} scopedGrantsAvailable workspacePath="F:\\workspace\\pidex" request={{requestId:mode,toolName:'exec_command',description:'命令或 cwd 指向工作区外路径',input:{cwd:${JSON.stringify('F:\\workspace\\pidex')},command:${JSON.stringify("Get-ChildItem -LiteralPath 'C:\\Users\\XiaoHi\\Desktop\\文档\\CodeX-Use\\Personal Agent' -Force | Select-Object Mode,Length,LastWriteTime,Name | Format-Table -AutoSize | Out-String -Width 400 | Write-Output\n# 确认外部目录清单后再继续读取目标文件")}},grantOptions:[{id:'session-1',kind:'command',scope:'session',label:'在此会话中允许（当前项目）'},{id:'project-1',kind:'command',scope:'project',label:'始终允许（当前项目）'}],...(mode==='grant'?{requestKind:'permission-grant',permissionGrant:{allowedScopes:['tool-call','turn'],requestedScope:'tool-call',requestedPermissions:{readPaths:['F:/workspace/src'],networkDomains:['example.com']}}}:{})}} onDecide={(_request,behavior,_always,_input,extras)=>{window.decisions.push({requestId:_request.requestId,behavior,updatedInput:_input,extras});return new Promise((resolve,reject)=>{window.resolveDecision=resolve;window.rejectDecision=reject})}} />
    : null}
  </main>;
}
resetState();
createRoot(document.getElementById('root')).render(<Harness/>);
`
if (process.versions.bun) {
  const result = await Bun.build({
    entrypoints: ['question-harness'],
    target: 'browser',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'question-harness',
        setup(builder) {
          builder.onResolve({ filter: /^react(?:\/.*)?$|^react-dom\/client$/ }, (args) => ({
            path: Bun.resolveSync(args.path, rendererRoot),
            namespace: 'file',
          }))
          builder.onResolve({ filter: /^question-harness$/ }, () => ({
            path: 'harness',
            namespace: 'question',
          }))
          builder.onLoad({ filter: /^harness$/, namespace: 'question' }, () => ({
            contents: harness,
            loader: 'jsx',
            resolveDir: rendererRoot,
          }))
        },
      },
    ],
  })
  assert.ok(result.success, result.logs.map(String).join('\n'))
  const child = Bun.spawn(['node', '--experimental-strip-types', fileURLToPath(import.meta.url)], {
    stdin: new Blob([await result.outputs[0]!.text()]),
    stdout: 'inherit',
    stderr: 'inherit',
  })
  process.exit(await child.exited)
}
let script = ''
for await (const chunk of process.stdin) script += chunk.toString('utf8')
const css = await compileEntryStyles()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('http://localhost/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><head><style>${css}</style></head><body><div id="root"></div></body></html>`,
    }),
  )
  await page.goto('http://localhost/')
  await page.addScriptTag({ content: script, type: 'module' })
  await page.waitForLoadState('networkidle')

  const card = page.locator('.ask-user-question-approval')
  const plan = page.locator('.request-card[data-variant="plan"]')
  const count = () => page.evaluate('window.submissions.length')
  const mode = (name: string) => page.getByRole('button', { name, exact: true }).click()
  const choice = (label: string) => card.getByRole('radio').filter({ hasText: label })
  const pagination = card.getByRole('group', { name: '问题导航', exact: true })
  const next = pagination.getByRole('button', { name: '下一题', exact: true })
  const previous = pagination.getByRole('button', { name: '上一题', exact: true })
  const pillSubmit = card
    .locator('.ask-user-question-pill-actions')
    .getByRole('button', { name: '提交', exact: true })
  const confirmSubmit = card.getByRole('button', { name: '确认提交', exact: true })
  const customInput = card.getByRole('textbox', { name: '自定义回答' })
  const stopTurn = card.getByRole('button', { name: '停止本轮', exact: true })
  const closeChat = card.getByRole('button', { name: '关闭', exact: true })

  // ---------------------------------------------------------------- chat 提问
  await mode('聊天提问')
  await expect(card).toContainText('1 of 3')
  await expect(pagination.getByRole('button')).toHaveCount(2)
  await expect(pagination).toContainText('1 of 3')
  await expect(previous).toBeDisabled()
  await expect(card.locator('h3')).toHaveCount(1)
  await expect(card).not.toContainText('需要你确认')
  // Chat 保留首项预选与「推荐」徽标。
  await expect(choice('仅桌面端')).toHaveAttribute('aria-checked', 'true')
  await expect(choice('仅桌面端')).toContainText('推荐')
  await expect(closeChat).toBeVisible()

  // 点击选项后约 150ms 自动切到下一待答题；返回可查看已选草稿。
  await choice('桌面端与 CLI').click()
  await expect(card).toContainText('2 of 3')
  assert.equal(await count(), 0)
  await previous.click()
  await expect(card).toContainText('1 of 3')
  await expect(choice('桌面端与 CLI')).toHaveAttribute('aria-checked', 'true')
  await next.click()
  await expect(card).toContainText('2 of 3')

  // 自定义回答、换行、中文输入法 composing 与 Enter 确认。
  await expect(card.getByRole('button', { name: '跳过当前问题' })).toBeVisible()
  await customInput.fill('中文自定义回答')
  await customInput.press('ArrowLeft')
  await customInput.press('Shift+Enter')
  await expect(customInput).toHaveValue('中文自定义回\n答')
  await expect(card).toContainText('2 of 3')
  await customInput.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
    ),
  )
  await expect(card).toContainText('2 of 3')
  await customInput.press('Enter')
  await expect(card).toContainText('3 of 3')
  await expect(next).toBeDisabled()

  // 最后一题：跳过能力开关与进入汇总页确认提交。
  const skip = card.getByRole('button', { name: '跳过当前问题' })
  await expect(skip).toBeVisible()
  await page.getByRole('button', { name: '切换跳过能力', exact: true }).click()
  await expect(skip).toBeDisabled()
  await page.getByRole('button', { name: '切换跳过能力', exact: true }).click()
  await expect(skip).toBeEnabled()
  await choice('暂时没有').click()
  await expect(card).toContainText('已收集全部确认，是否提交？')
  await expect(card).toContainText('桌面端与 CLI')
  await expect(card).toContainText('暂时没有')
  // 点击汇总项返回修改，再回到汇总页确认提交。
  await card.locator('.ask-user-question-summary-row').nth(2).click()
  await expect(card).toContainText('3 of 3')
  await pillSubmit.click()
  await expect(card).toContainText('已收集全部确认，是否提交？')
  await confirmSubmit.click()
  await expect.poll(count).toBe(1)
  assert.deepEqual(await page.evaluate('window.submissions[0].answers'), {
    scope: '桌面端与 CLI',
    phase: '中文自定义回\n答',
    extra: '暂时没有',
  })

  // 单题卡片：不显示分页、点击选项停留在当前题并切换按钮为「提交」。
  await mode('单题提问')
  await expect(card).not.toContainText('1 of 1')
  await choice('桌面端与 CLI').click()
  await expect(card).not.toContainText('已收集全部确认')
  await pillSubmit.click()
  await expect.poll(count).toBe(1)
  assert.deepEqual(await page.evaluate('window.submissions[0].answers'), {
    scope: '桌面端与 CLI',
  })

  // Chat 的 Escape 与关闭按钮都忽略整组问题。
  await mode('聊天提问')
  await card.press('Escape')
  assert.equal(await page.evaluate('window.rejects'), 1)
  assert.equal(await count(), 0)
  await mode('聊天提问')
  await closeChat.click()
  assert.equal(await page.evaluate('window.rejects'), 1)

  // 多选：点击不自动翻题，需显式点击「下一题」推进并在汇总页统一提交。
  await mode('聊天提问')
  await page.getByRole('button', { name: '多选', exact: true }).click()
  await card.getByRole('checkbox').filter({ hasText: '桌面端与 CLI' }).click()
  await expect(card).toContainText('1 of 3')
  await card
    .locator('.ask-user-question-pill-actions')
    .getByRole('button', { name: '下一题', exact: true })
    .click()
  await choice('提问交互').click()
  await choice('暂时没有').click()
  await expect(card).toContainText('已收集全部确认，是否提交？')
  await confirmSubmit.click()
  await expect.poll(count).toBe(1)
  assert.deepEqual(await page.evaluate('window.submissions[0].answers'), {
    scope: '仅桌面端, 桌面端与 CLI',
    phase: '提问交互',
    extra: '暂时没有',
  })

  // 提交失败：就地提示、保留草稿、重试复用同一次提交路径。
  await mode('聊天提问')
  await page.evaluate('window.asyncSubmission=true')
  await choice('桌面端与 CLI').click()
  await choice('提问交互').click()
  await choice('暂时没有').click()
  await expect(card).toContainText('已收集全部确认，是否提交？')
  await confirmSubmit.click()
  await expect.poll(count).toBe(1)
  await expect(card.getByRole('button', { name: '提交中…', exact: true })).toBeDisabled()
  await page.evaluate('window.rejectSubmission(new Error("请求失败"))')
  await expect(card).toContainText('提交回答失败，请重试。')
  await confirmSubmit.click()
  await expect.poll(count).toBe(2)
  await page.evaluate('window.resolveSubmission()')

  // ------------------------------------------------------- plan 提问（逐题确认）
  await mode('计划提问')
  await expect(card).not.toContainText('需要你确认')
  await expect(card).toContainText('1 of 3')
  await expect(choice('仅桌面端')).toHaveAttribute('aria-checked', 'true')
  await expect(card.locator('.ask-user-question-recommendation')).toHaveText('推荐')
  // Plan 顶部右侧为「停止本轮」按钮。
  await expect(stopTurn).toBeVisible()

  // 方向键只移动焦点，不改变答案。
  await choice('仅桌面端').focus()
  await choice('仅桌面端').press('ArrowDown')
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute('aria-checked')),
    'false',
  )
  assert.equal(
    await page.evaluate(() => (document.activeElement?.textContent ?? '').includes('桌面端与 CLI')),
    true,
  )
  await expect(choice('仅桌面端')).toHaveAttribute('aria-checked', 'true')

  // 单选与自定义回答互斥。
  await customInput.focus()
  await expect(choice('仅桌面端')).toHaveAttribute('aria-checked', 'true')
  await customInput.fill('自定义覆盖')
  await expect(choice('仅桌面端')).toHaveAttribute('aria-checked', 'false')
  await customInput.fill('')

  // 文本框：Shift+Enter 换行、Enter / Ctrl+Enter 确认、中文输入法 composing 不确认。
  await customInput.click()
  await customInput.fill('第一行')
  await customInput.press('Shift+Enter')
  await page.keyboard.insertText('第二行')
  await expect(customInput).toHaveValue('第一行\n第二行')
  await expect(card).toContainText('1 of 3')
  await customInput.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
    ),
  )
  await expect(card).toContainText('1 of 3')
  await customInput.press('Control+Enter')
  await expect(card).toContainText('2 of 3')

  // Escape 只退出当前编辑焦点，不忽略整组问题、不中断。
  await mode('计划提问')
  await card.press('Escape')
  await expect(card).toContainText('1 of 3')
  assert.equal(await page.evaluate('window.rejects'), 0)
  assert.equal(await page.evaluate('window.interrupts'), 0)
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true)

  // 数字快捷键选定后自动推进；缺答时回到待答题，全部作答后进入汇总页，支持重置与返回修改。
  await mode('计划提问')
  await card.press('2')
  await expect(card).toContainText('2 of 3')
  await next.click()
  await expect(card).toContainText('3 of 3')
  // 第 2 题尚未回答，选完第 3 题后回绕到第 2 题。
  await choice('暂时没有').click()
  await expect(card).toContainText('2 of 3')
  await choice('提问交互').click()
  await expect(card).toContainText('已收集全部确认，是否提交？')
  await confirmSubmit.click()
  await expect.poll(count).toBe(1)
  assert.deepEqual(await page.evaluate('window.submissions[0].answers'), {
    scope: '桌面端与 CLI',
    phase: '提问交互',
    extra: '暂时没有',
  })

  // 汇总页「重置」清空答案并回到第 1 题。
  await mode('计划提问')
  await choice('仅桌面端').click()
  await choice('提问交互').click()
  await choice('暂时没有').click()
  await expect(card).toContainText('已收集全部确认，是否提交？')
  await card.getByRole('button', { name: '重置', exact: true }).click()
  await expect(card).toContainText('1 of 3')
  assert.equal(await card.locator('[aria-checked="true"]').count(), 0)

  // 「停止本轮」走现有中断链路；中断失败保留草稿。
  await mode('计划提问')
  await customInput.fill('停止前的草稿')
  await stopTurn.click()
  assert.equal(await page.evaluate('window.interrupts'), 1)
  assert.equal(await page.evaluate('window.rejects'), 0)
  await expect(stopTurn).toBeDisabled()
  await expect(customInput).toBeDisabled()
  await page.evaluate('window.rejectInterrupt(new Error("中断失败"))')
  await expect(card.locator('.ask-user-question-error')).toContainText('中断')
  await expect(customInput).toHaveValue('停止前的草稿')
  await expect(stopTurn).toBeEnabled()
  await stopTurn.click()
  assert.equal(await page.evaluate('window.interrupts'), 2)
  await page.evaluate('window.resolveInterrupt()')
  await expect(card).toHaveCount(0)
  await expect(page.getByText('对话已中断', { exact: true })).toBeVisible()

  // 纯文本题只展示输入区，不保留空选项列表。
  await mode('纯文本计划题')
  assert.equal(await card.locator('[role="radiogroup"]').count(), 0)
  assert.equal(await card.getByRole('radio').count(), 0)
  await expect(card.locator('.ask-user-question-pill-row')).toHaveCount(1)
  await expect(card).not.toContainText('自己回答')
  await customInput.fill('只有文本回答')
  await pillSubmit.click()
  await expect.poll(count).toBe(1)
  assert.deepEqual(await page.evaluate('window.submissions[0].answers'), { free: '只有文本回答' })

  // 会话切换：Plan 草稿按聊天隔离，切走再回来仍保留，且不写入浏览器存储。
  await mode('计划提问')
  await choice('仅桌面端').click()
  await expect(card).toContainText('2 of 3')
  await customInput.fill('聊天 A 的草稿')
  await page.getByRole('button', { name: '切换聊天', exact: true }).click()
  // 新聊天不继承上一聊天的答案与草稿。
  await expect(card).toContainText('1 of 3')
  await expect(choice('仅桌面端')).toHaveAttribute('aria-checked', 'true')
  await expect(customInput).toHaveValue('')
  await customInput.fill('聊天 B 的草稿')
  await expect(card).toContainText('1 of 3')
  // 切回原聊天：题号与草稿都保留，未被另一个聊天覆盖。
  await page.getByRole('button', { name: '切换聊天', exact: true }).click()
  await expect(card).toContainText('2 of 3')
  await expect(customInput).toHaveValue('聊天 A 的草稿')
  await previous.click()
  await expect(card).toContainText('1 of 3')
  await expect(choice('桌面端与 CLI')).toHaveAttribute('aria-checked', 'false')
  await expect(choice('仅桌面端')).toHaveAttribute('aria-checked', 'true')
  await expect(customInput).toHaveValue('')
  assert.equal(await page.evaluate('window.rejects'), 0)
  // 再切到另一个聊天：它的草稿同样独立保留。
  await page.getByRole('button', { name: '切换聊天', exact: true }).click()
  await expect(card).toContainText('1 of 3')
  await expect(customInput).toHaveValue('聊天 B 的草稿')
  // 草稿只活在 Renderer 生命周期内，不写浏览器持久存储。
  assert.equal(
    await page.evaluate(() => window.localStorage.length + window.sessionStorage.length),
    0,
  )

  // ------------------------------------------------------------ plan 审阅动作
  await mode('计划审批')
  await expect(plan).toContainText('实施此计划？')
  await expect(plan).not.toContainText('计划已准备好')
  await expect(plan).not.toContainText('查看全文')
  await expect(plan).not.toContainText('Plan 流程与交互重设计')
  await expect(plan).not.toContainText('修改计划')
  await expect(plan).not.toContainText('开始实施')
  await expect(plan).not.toContainText('退出 Plan')
  const implementOption = plan.getByRole('radio', { name: /是，实施此计划/u })
  await expect(implementOption).toHaveAttribute('aria-checked', 'true')
  assert.equal(await plan.getByRole('radio', { name: /在新聊天中实施/u }).count(), 0)
  await expect(plan.getByRole('button', { name: '忽略', exact: true })).toBeVisible()
  await expect(plan.getByRole('button', { name: '提交', exact: true })).toBeVisible()
  // 默认选中“是，实施此计划”，点击提交直接按当前聊天实施。
  await plan.getByRole('button', { name: '提交', exact: true }).click()
  assert.deepEqual(await page.evaluate('window.responses[0]'), { action: 'implement' })

  // Escape 或点击“忽略”发送 close。
  await mode('计划审批')
  await plan.getByRole('button', { name: '忽略', exact: true }).click()
  assert.deepEqual(await page.evaluate('window.responses[0]'), { action: 'close' })
  await mode('计划审批')
  await page.locator('.plan-approval-card').press('Escape')
  assert.deepEqual(await page.evaluate('window.responses[0]'), { action: 'close' })

  await mode('计划审批-新聊天能力')
  assert.equal(await plan.getByRole('radio', { name: /在新聊天中实施/u }).count(), 0)
  await plan.getByRole('button', { name: '提交', exact: true }).click()
  assert.deepEqual(await page.evaluate('window.responses[0]'), { action: 'implement' })

  // 输入自定义反馈取消选项选中，清空恢复默认选中；回车提交 feedback。
  await mode('计划审批')
  const feedback = plan.getByRole('textbox', { name: '调整计划意见' })
  await feedback.fill('先完成提问交互')
  await expect(implementOption).toHaveAttribute('aria-checked', 'false')
  await feedback.fill('')
  await expect(implementOption).toHaveAttribute('aria-checked', 'true')
  await feedback.fill('先完成提问交互，计划侧栏放到下一阶段')
  await feedback.press('Enter')
  assert.deepEqual(await page.evaluate('window.responses[0]'), {
    action: 'feedback',
    feedback: '先完成提问交互，计划侧栏放到下一阶段',
  })

  // 提交中锁定动作；失败就地提示后恢复。
  await mode('计划审批')
  await page.evaluate('window.asyncResponse=true')
  await plan.getByRole('button', { name: '提交', exact: true }).click()
  await expect(plan.getByRole('button', { name: '提交中…', exact: true })).toBeVisible()
  await expect(plan.getByRole('button', { name: '忽略', exact: true })).toBeDisabled()
  await expect(feedback).toBeDisabled()
  await page.evaluate('window.rejectResponse(new Error("失败"))')
  await expect(plan.getByRole('alert')).toContainText('操作失败')
  await expect(plan.getByRole('button', { name: '提交', exact: true })).toBeEnabled()

  await mode('计划审批')
  await page.waitForTimeout(250)
  await page.screenshot({ path: resolve(tmpdir(), 'pidex-plan-approval-light.png') })
  await page.getByRole('button', { name: '深色', exact: true }).click()
  await page.waitForTimeout(100)
  await page.screenshot({ path: resolve(tmpdir(), 'pidex-plan-approval-dark.png') })
  await mode('计划提问')
  await page.waitForTimeout(250)
  await page.screenshot({ path: resolve(tmpdir(), 'pidex-plan-question-dark.png') })
  await page.getByRole('button', { name: '浅色', exact: true }).click()
  await page.waitForTimeout(100)
  await page.screenshot({ path: resolve(tmpdir(), 'pidex-plan-question-light.png') })

  // ------------------------------------------------------------- 并排隔离
  await mode('并排问题')
  const owner0 = page.locator('[data-owner="0"]')
  const owner1 = page.locator('[data-owner="1"]')
  await owner0.locator('.ask-user-question-approval').press('ArrowRight')
  await expect(owner0).toContainText('2 of 3')
  await expect(owner1).toContainText('1 of 3')
  await owner0.getByRole('textbox', { name: '自定义回答' }).press('Escape')
  assert.deepEqual(await page.evaluate('window.ownerActions'), [0])

  // ------------------------------------------------------------- 权限与授权
  await mode('权限')
  const permission = page.locator('.request-card[data-variant="permission"]')
  await expect(permission).toContainText(
    '需要在工作区外的 C:\\Users\\XiaoHi\\Desktop\\文档\\CodeX-Use\\Personal Agent 目录运行 Get-ChildItem，是否允许执行？',
  )
  await expect(permission).not.toContainText('命令或 cwd 指向工作区外路径')
  await expect(permission).not.toContainText('工作区外的 F:\\workspace\\pidex')
  await expect(permission.locator('.canonical-command-shell.canonical-command-card')).toBeVisible()
  const commandToggle = permission.getByRole('button', { name: /展开命令/u })
  await expect(commandToggle).toBeVisible()
  await commandToggle.click()
  await expect(permission.getByRole('button', { name: /收起命令/u })).toBeVisible()
  await expect(permission.getByRole('radio')).toHaveCount(3)
  const allowOnce = permission.getByRole('radio', { name: '是', exact: true })
  await expect(allowOnce).toHaveAttribute('aria-checked', 'true')
  await expect(permission.getByRole('radio', { name: /是，且本次会话不再询问/u })).toBeVisible()
  await expect(permission.getByRole('radio', { name: /是，且当前项目不再询问/u })).toBeVisible()
  const denyFeedback = permission.getByRole('textbox', { name: '拒绝并告知 Pidex 如何调整' })
  await expect(denyFeedback).toBeVisible()
  await expect(permission.getByRole('button', { name: '忽略', exact: true })).toBeVisible()
  const permissionSubmit = permission.getByRole('button', { name: '提交', exact: true })
  await permissionSubmit.click()
  await expect(permission.getByRole('button', { name: '提交中…', exact: true })).toBeDisabled()
  await expect(permission.getByRole('button', { name: '忽略', exact: true })).toBeDisabled()
  await page.evaluate('window.rejectDecision(new Error("失败"))')
  await expect(permission.getByRole('alert')).toContainText('操作失败')
  await denyFeedback.fill('请先运行单测而不是全量测试')
  await expect(allowOnce).toHaveAttribute('aria-checked', 'false')
  await permissionSubmit.click()
  assert.deepEqual(
    await page.evaluate(
      'window.decisions.map((x)=>({behavior:x.behavior,updatedInput:x.updatedInput}))',
    ),
    [
      { behavior: 'allow', updatedInput: undefined },
      { behavior: 'deny', updatedInput: { feedback: '请先运行单测而不是全量测试' } },
    ],
  )
  await page.evaluate('window.resolveDecision()')

  await mode('权限')
  await page.waitForTimeout(250)
  await page.screenshot({ path: resolve(tmpdir(), 'pidex-permission-light.png') })
  await page.getByRole('button', { name: '深色', exact: true }).click()
  await page.waitForTimeout(100)
  await page.screenshot({ path: resolve(tmpdir(), 'pidex-permission-dark.png') })
  await page.getByRole('button', { name: '浅色', exact: true }).click()

  await mode('授权范围')
  const grant = page.locator('.request-card[data-variant="permission-grant"]')
  await expect(grant).toContainText('F:/workspace/src')
  await expect(grant).toContainText('example.com')
  await expect(grant.getByRole('radio')).toHaveCount(2)
  await grant.getByRole('radio', { name: /当前轮次/u }).click()
  await expect(grant.getByRole('radio', { name: /当前轮次/u })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await grant.getByRole('button', { name: '提交', exact: true }).click()
  assert.deepEqual(await page.evaluate('window.decisions[0]'), {
    requestId: 'grant',
    behavior: 'allow',
    updatedInput: undefined,
    extras: { grantScope: 'turn' },
  })
  await page.evaluate('window.resolveDecision()')

  assert.deepEqual(errors, [])
  console.log(
    'Chat 提问、Plan 逐题确认、Plan 审阅动作与权限卡的交互检查全部通过。截图目录：' + tmpdir(),
  )
} finally {
  await browser.close()
}
