import type { DecisionAnswer } from '@pidex/shared/decision'
import type { JudgeProvider, JudgeRequest, ProviderResponse } from '../Judge'

/**
 * Deterministic judge for tests: answers are scripted per question id, or derived
 * from a fixed probability. Never performs I/O.
 */
export class MockJudgeProvider implements JudgeProvider {
  readonly id: string
  private readonly answers: Readonly<Record<string, DecisionAnswer>>
  private readonly defaultProbability: number

  constructor(
    options: {
      id?: string | undefined
      answers?: Readonly<Record<string, DecisionAnswer>> | undefined
      defaultProbability?: number | undefined
    } = {},
  ) {
    this.id = options.id ?? 'mock'
    this.answers = options.answers ?? {}
    this.defaultProbability = options.defaultProbability ?? 0.5
  }

  async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
    const answers: Record<string, DecisionAnswer> = {}
    for (const [id, question] of Object.entries(request.questions)) {
      const scripted = this.answers[id]
      if (scripted) {
        answers[id] = scripted
        continue
      }
      if (question.type === 'boolean') {
        answers[id] = { type: 'boolean', probability: this.defaultProbability }
      } else if (question.type === 'choice') {
        const options = Object.keys(question.criteria)
        answers[id] = {
          type: 'choice',
          choice: options[0]!,
          probabilities: Object.fromEntries(options.map((option) => [option, 1 / options.length])),
        }
      } else {
        answers[id] = { type: 'score', score: (question.criteria.length - 1) / 2 }
      }
    }
    return { answers, usage: { inputTokens: 0, outputTokens: 0 }, modelId: this.id }
  }
}
