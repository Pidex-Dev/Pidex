import { Schema } from 'effect'

export const ProviderTestResponseSchema = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.optional(Schema.String),
})
export type ProviderTestResponse = typeof ProviderTestResponseSchema.Type
