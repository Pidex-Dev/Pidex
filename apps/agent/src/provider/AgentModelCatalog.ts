import type { ModelService } from './runtime/ModelService'

/** The model surface consumed by the Agent and transport layers. */
export type AgentModelCatalog = Pick<
  ModelService,
  | 'list'
  | 'models'
  | 'resolve'
  | 'getModel'
  | 'getRuntimeModel'
  | 'registry'
  | 'refresh'
  | 'reload'
  | 'catalogRevision'
  | 'dispose'
>
