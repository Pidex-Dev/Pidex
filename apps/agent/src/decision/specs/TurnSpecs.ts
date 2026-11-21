import type { DecisionPointManifest } from '@pidex/shared/decision'
import { turnContinueSpec } from './TurnContinue'
import { turnCompletionSpec } from './TurnCompletion'

export * from './TurnContinue'
export * from './TurnCompletion'

/** Registration list for the turn plane: pass to DecisionService.registerManifest once at assembly. */
export const TURN_MANIFEST: readonly DecisionPointManifest[] = [
  {
    id: 'turn.continue',
    group: 'turn',
    title: 'Unfinished promise continuation',
    titleZh: '未完成承诺自动延续',
    summary:
      'Detects a turn that ended promising more work or asking for a go-ahead on already-requested work, and injects one continuation prompt. At most twice per user message; never for irreversible steps or during Goal settlement.',
    summaryZh:
      '检测回合结束时承诺后续动作或对已授权工作请求许可的情况，注入延续提示；每条用户消息最多 2 次，不可逆步骤与 Goal 结算期间不触发。',
    defaultMode: 'shadow',
    feature: 'decision.turn',
  },
  {
    id: 'turn.completion',
    group: 'turn',
    title: 'Completion verification reminder',
    titleZh: '完成前验证提醒',
    summary:
      'When code changed and the model declares the work done without running any test, build or type check afterwards, reminds it to verify once per turn.',
    summaryZh:
      '本轮有代码改动且模型宣告完成、但改动后未运行任何测试/构建/类型检查时，提醒验证一次（每轮最多 1 次）。',
    defaultMode: 'shadow',
    feature: 'decision.turn',
  },
]

/** The turn-plane specs, keyed by spec id. */
export const TURN_SPECS = {
  'turn.continue': turnContinueSpec,
  'turn.completion': turnCompletionSpec,
} as const