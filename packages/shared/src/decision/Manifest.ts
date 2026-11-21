import { Schema } from 'effect'
import { DecisionGroupSchema, DecisionModeSchema } from './Types'

const NonEmptyStringSchema = Schema.String.check(Schema.isMinLength(1))

/** Static metadata of a registered decision point, shown by settings and the Judge panel. */
export const DecisionPointManifestSchema = Schema.Struct({
  id: NonEmptyStringSchema,
  group: DecisionGroupSchema,
  title: NonEmptyStringSchema,
  titleZh: NonEmptyStringSchema,
  summary: NonEmptyStringSchema,
  summaryZh: NonEmptyStringSchema,
  defaultMode: DecisionModeSchema,
  feature: NonEmptyStringSchema,
})
export type DecisionPointManifest = typeof DecisionPointManifestSchema.Type