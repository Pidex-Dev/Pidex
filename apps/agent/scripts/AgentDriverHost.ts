import { Effect } from 'effect'
import { createBootstrap } from '../src/Bootstrap'
import { createPlanSmokeModels, initializePlanSmokeDatabase } from './PlanSmokeFixture'

/**
 * Isolated headless Agent runtime handle created for {@link bootAgentDriverRuntime}.
 */
export interface AgentDriverRuntimeHandle {
  app: Effect.Success<ReturnType<typeof createBootstrap>>['app']
  db: Effect.Success<ReturnType<typeof createBootstrap>>['db']
  dispose: () => Promise<void>
  model: { provider: string; id: string }
}

function seedOfflinePricingCache(db: {
  sqlite: {
    query: (sql: string) => { run: (id: string, payload: string, checkedAt: number) => unknown }
  }
}): void {
  const now = Date.now()
  const year = new Date(now).getUTCFullYear()
  const upsert = db.sqlite.query(
    'INSERT INTO model_pricing_cache(id,payload,checked_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, checked_at=excluded.checked_at',
  )
  upsert.run('fx:CNY:USD', JSON.stringify(null), now)
  for (const targetYear of [year - 1, year, year + 1]) {
    upsert.run(`calendar:${targetYear}`, JSON.stringify(null), now)
  }
}

/**
 * Boots an isolated headless Agent runtime with deterministic faux models and offline pricing cache.
 */
export async function bootAgentDriverRuntime(): Promise<AgentDriverRuntimeHandle> {
  const fixture = createPlanSmokeModels()
  const runtime = await Effect.runPromise(
    createBootstrap({
      models: fixture.models,
      initializeDatabase: (db) => {
        initializePlanSmokeDatabase(db)
        seedOfflinePricingCache(db)
      },
    }),
  )
  return {
    app: runtime.app,
    db: runtime.db,
    dispose: () => runtime.dispose(),
    model: { provider: fixture.model.provider, id: fixture.model.id },
  }
}
