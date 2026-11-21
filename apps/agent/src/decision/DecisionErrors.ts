import type { JudgeErrorKind } from '@pidex/shared/decision'

/**
 * Why a judge call failed. Callers branch on `kind`, never on message text.
 * Messages name the service at most; they never carry keys or submitted state.
 */
export class JudgeError extends Error {
  readonly kind: JudgeErrorKind
  readonly status: number | undefined
  readonly endpoint: string | undefined

  constructor(
    kind: JudgeErrorKind,
    message: string,
    options?: { status?: number; endpoint?: string; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'JudgeError'
    this.kind = kind
    this.status = options?.status
    this.endpoint = options?.endpoint
  }
}

export const isJudgeError = (error: unknown): error is JudgeError => error instanceof JudgeError

export const judgeErrorKindOf = (error: unknown): JudgeErrorKind =>
  isJudgeError(error) ? error.kind : 'unexpected'
