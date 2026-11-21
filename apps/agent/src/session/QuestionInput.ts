import { z } from 'zod'
import { QUESTION_CHOICES_READ_MAX, QUESTION_CHOICES_WRITE_MAX } from '@pidex/shared/thread'

export const questionOptionSchema = z
  .object({
    label: z.string().trim().min(1),
    description: z.string().trim().min(1),
    recommended: z.boolean().optional(),
  })
  .strict()

export const richQuestionSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    header: z.string().trim().min(1).max(12),
    question: z.string().trim().min(1),
    options: z
      .array(questionOptionSchema)
      .max(QUESTION_CHOICES_WRITE_MAX)
      .refine((options) => options.length !== 1, '提供零项或二至五项选项'),
    multiSelect: z.boolean().optional(),
  })
  .strict()

export const requestUserInputSchema = z
  .object({
    questions: z.array(richQuestionSchema).min(1).max(5),
    autoResolutionMs: z.number().int().min(60_000).max(240_000).optional(),
  })
  .strict()

export type RichQuestion = z.infer<typeof richQuestionSchema>
export type RequestUserInput = z.infer<typeof requestUserInputSchema>

export interface InteractionQuestion {
  id: string
  header: string
  prompt: string
  choices: Array<{
    id: string
    label: string
    description: string
    recommended: boolean
  }>
  allowFreeform: true
  required: true
  minAnswers: number
  maxAnswers: number
}

export const interactionQuestions = (questions: readonly RichQuestion[]): InteractionQuestion[] =>
  questions.map((question) => ({
    id: question.id,
    header: question.header,
    prompt: question.question,
    choices: question.options.map((option, index) => ({
      id: `${question.id}:${index}`,
      label: option.label,
      description: option.description,
      recommended: option.recommended ?? /[（(](?:recommended|推荐)[）)]\s*$/iu.test(option.label),
    })),
    allowFreeform: true,
    required: true,
    minAnswers: 1,
    // QuestionService 以 choiceIds.length + (text ? 1 : 0) 计数：多选可全选所有
    // 预设项并附加一段自由文本，因此上限是选项数加一。
    maxAnswers: question.multiSelect ? question.options.length + 1 : 1,
  }))

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/**
 * 把已落库的 question payload 归一化为 InteractionQuestion。写入侧上限只约束
 * 模型，读取侧必须接受任何构建写入的问题，否则同一份共享数据会出现“看得到
 * 卡片却无法作答”。InteractionService.listPending 复用本函数。
 */
export const storedQuestions = (payload: Record<string, unknown>): InteractionQuestion[] => {
  if (!Array.isArray(payload.questions)) return []
  return payload.questions.flatMap((value) => {
    const question = record(value)
    if (
      typeof question.id !== 'string' ||
      typeof question.header !== 'string' ||
      typeof question.prompt !== 'string' ||
      !Array.isArray(question.choices)
    )
      return []
    const choices = question.choices.flatMap((item) => {
      const choice = record(item)
      return typeof choice.id === 'string' &&
        typeof choice.label === 'string' &&
        typeof choice.description === 'string'
        ? [
            {
              id: choice.id,
              label: choice.label,
              description: choice.description,
              recommended: choice.recommended === true,
            },
          ]
        : []
    })
    if (choices.length > QUESTION_CHOICES_READ_MAX) return []
    return [
      {
        id: question.id,
        header: question.header,
        prompt: question.prompt,
        choices,
        allowFreeform: true as const,
        required: true as const,
        minAnswers: typeof question.minAnswers === 'number' ? question.minAnswers : 1,
        maxAnswers: typeof question.maxAnswers === 'number' ? question.maxAnswers : 1,
      },
    ]
  })
}

/**
 * Formats a persisted question answer for model consumption by attaching each
 * question prompt and host-matched selectedChoices labels to opaque choiceIds
 * so the model never guesses indices while persisted IDs remain unchanged.
 */
export const formatQuestionAnswerForModel = (
  payload: Record<string, unknown>,
  storedAnswer: Record<string, unknown>,
): string | null => {
  const answer = Object.prototype.hasOwnProperty.call(storedAnswer, 'value')
    ? storedAnswer.value
    : null
  const resolved = record(answer)
  const questions = storedQuestions(payload)
  const answerForModel = Array.isArray(resolved.answers)
    ? {
        ...resolved,
        answers: resolved.answers.map((value) => {
          const item = record(value)
          const question = questions.find(({ id }) => id === item.questionId)
          return question
            ? {
                ...item,
                question: question.prompt,
                selectedChoices: question.choices
                  .filter(({ id }) => Array.isArray(item.choiceIds) && item.choiceIds.includes(id))
                  .map(({ id, label }) => ({ id, label })),
              }
            : item
        }),
      }
    : answer
  return typeof answerForModel === 'string'
    ? answerForModel
    : answerForModel == null
      ? null
      : JSON.stringify(answerForModel)
}
