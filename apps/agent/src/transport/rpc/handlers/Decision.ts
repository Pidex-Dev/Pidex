import { DecisionRpcMethods, type RpcMethod } from '@pidex/agent-protocol'
import { Schema } from 'effect'
import { decodeRpcParams } from '../Decoders'
import type { RpcRouter } from '../RpcRouter'
import type { RpcRouterContext } from '../RequestContext'

const decodeGetConfig = (raw: unknown) =>
  decodeRpcParams(
    Schema.decodeUnknownSync(DecisionRpcMethods['decision/getConfig'].params),
    raw,
    'decision/getConfig',
  )
const decodeUpdateConfig = (raw: unknown) =>
  decodeRpcParams(
    Schema.decodeUnknownSync(DecisionRpcMethods['decision/updateConfig'].params),
    raw,
    'decision/updateConfig',
  )
const decodeSetJudgeApiKey = (raw: unknown) =>
  decodeRpcParams(
    Schema.decodeUnknownSync(DecisionRpcMethods['decision/setJudgeApiKey'].params),
    raw,
    'decision/setJudgeApiKey',
  )
const decodeProbe = (raw: unknown) =>
  decodeRpcParams(
    Schema.decodeUnknownSync(DecisionRpcMethods['decision/probe'].params),
    raw,
    'decision/probe',
  )
const decodeListLedger = (raw: unknown) =>
  decodeRpcParams(
    Schema.decodeUnknownSync(DecisionRpcMethods['decision/listLedger'].params),
    raw,
    'decision/listLedger',
  )
const decodeMarkOutcome = (raw: unknown) =>
  decodeRpcParams(
    Schema.decodeUnknownSync(DecisionRpcMethods['decision/markOutcome'].params),
    raw,
    'decision/markOutcome',
  )

export const decisionHandlers = {
  name: 'decision',
  methods: Object.keys(DecisionRpcMethods) as readonly RpcMethod[],
  async handle(
    runtime: RpcRouter,
    method: RpcMethod,
    rawParams: unknown,
    _context: RpcRouterContext,
  ) {
    const service = runtime.decisions
    switch (method) {
      case 'decision/getConfig':
        return service.getConfigView(decodeGetConfig(rawParams).cwd)
      case 'decision/updateConfig':
        return service.updateConfig(decodeUpdateConfig(rawParams))
      case 'decision/setJudgeApiKey':
        return service.setJudgeApiKey(decodeSetJudgeApiKey(rawParams))
      case 'decision/probe':
        return service.probe(decodeProbe(rawParams))
      case 'decision/listLedger':
        return service.listLedger(decodeListLedger(rawParams))
      case 'decision/markOutcome':
        return service.markOutcome(decodeMarkOutcome(rawParams))
      default:
        return undefined
    }
  },
}
