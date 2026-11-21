import { ABSTAIN, defineDecision } from '../DecisionSpec'
import { pickChoice } from '../DecisionPolicy'

/** One chunk of an overlong tool output. `call` names what produced it. */
export interface ToolAdmissionInput {
  readonly call: string
  readonly chunk: string
}

export type AdmissionKind = 'error' | 'result' | 'progress' | 'warning' | 'passing'

export type ToolAdmissionOutcome = {
  readonly kind: AdmissionKind | 'unknown'
  readonly drop: boolean
}

const KINDS: readonly AdmissionKind[] = ['error', 'result', 'progress', 'warning', 'passing']
const NOISE: readonly AdmissionKind[] = ['progress', 'warning', 'passing']

/**
 * Admission control for overlong tool output: what a chunk IS, not whether it
 * looks relevant. Only a confident noise class drops a chunk; the caller must
 * archive whatever it drops and leave a read pointer, so a wrong verdict stays
 * recoverable.
 */
export const toolAdmissionSpec = defineDecision({
  id: 'tool.admission',
  version: 1,
  cacheImpact: 'append-only',
  latency: 'inline',
  capabilities: 'screen',
  questions: {
    kind: {
      type: 'choice',
      instructions: 'What kind of output is `chunk`?',
      criteria: {
        error: 'An error, a failure or a stack trace',
        result: 'Search results, file contents or data',
        progress: 'Progress, downloads or build status',
        warning: 'Repeated warnings or deprecation notices',
        passing: 'Tests or checks that passed',
        other: 'Something else',
      },
    },
  },
  buildState(input: ToolAdmissionInput) {
    return { call: input.call, chunk: input.chunk }
  },
  policy(answers): ToolAdmissionOutcome | typeof ABSTAIN {
    const answer = answers.kind
    if (answer?.judge === 'untrusted' || answer?.judge === 'unavailable') return ABSTAIN
    if (answer?.type !== 'choice') return { kind: 'unknown', drop: false }
    const picked = pickChoice(answer)
    const kind = KINDS.find((known) => known === picked) ?? 'unknown'
    return { kind, drop: kind !== 'unknown' && NOISE.includes(kind) }
  },
  fallback(): ToolAdmissionOutcome {
    return { kind: 'unknown', drop: false }
  },
})

/**
 * Splits text into pieces of at most `size` characters, preferring line
 * boundaries. Joined with nothing between them, the pieces give back the text
 * exactly.
 */
export function splitChunks(text: string, size: number): string[] {
  if (!text) return []
  const out: string[] = []
  let rest = text
  while (rest.length > size) {
    const lineEnd = rest.lastIndexOf('\n', size)
    const cut = lineEnd >= size / 2 ? lineEnd + 1 : size
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) out.push(rest)
  return out
}

/** The one-line pointer that stands in a dropped chunk's place. */
export const admissionPointer = (characters: number): string =>
  `[pidex 已折叠此段 ${characters} 字符的重复/进度输出，全文见归档]`