import { secretScrubber } from '../security/SecretScrubber'

const CREDENTIAL_NAME =
  /SECRET|TOKEN|PASSWD|PASSWORD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|(?:^|_)KEYS?(?:_|$)/i

/**
 * Values of this process's credential variables, longest first so none is left
 * half replaced. Short digit-free values are settings, not secrets.
 */
export function environmentSecrets(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const values = Object.entries(env).flatMap(([name, raw]) => {
    const value = raw?.trim() ?? ''
    const secretish = value.length >= 16 || (value.length >= 8 && /\d/.test(value))
    return secretish && CREDENTIAL_NAME.test(name) ? [value] : []
  })
  return [...new Set(values)].sort((a, b) => b.length - a.length)
}

/**
 * SAFETY: everything a judge is shown or the ledger stores passes through here:
 * known credential values wherever they appear, then the shared SecretScrubber
 * for credential-shaped tokens and assignments.
 */
export function redactForJudge<T>(value: T, known: readonly string[] = []): T {
  const replaceKnown = (input: unknown): unknown => {
    if (typeof input === 'string') {
      let clean = input
      for (const secret of known)
        if (clean.includes(secret)) clean = clean.split(secret).join('<redacted>')
      return clean
    }
    if (Array.isArray(input)) return input.map(replaceKnown)
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input).map(([key, item]) => [key, replaceKnown(item)]),
      )
    return input
  }
  return secretScrubber.scrub(replaceKnown(value)) as T
}
