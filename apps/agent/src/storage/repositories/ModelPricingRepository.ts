import type { Database } from 'bun:sqlite'
export const MODEL_PRICING_SCHEMA = [
  'CREATE TABLE model_price_snapshots (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL)',
  'CREATE TABLE model_pricing_cache (id TEXT PRIMARY KEY, payload TEXT NOT NULL, checked_at INTEGER NOT NULL)',
] as const
export class ModelPricingRepository {
  private readonly available: boolean
  constructor(private readonly sqlite: Database) {
    this.available = Boolean(
      sqlite
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='model_pricing_cache'")
        .get(),
    )
  }
  read(id: string): { payload: unknown; checkedAt: number } | undefined {
    if (!this.available) return
    const row = this.sqlite
      .query('SELECT payload, checked_at FROM model_pricing_cache WHERE id=?')
      .get(id) as { payload: string; checked_at: number } | null
    if (row) {
      try {
        return { payload: JSON.parse(row.payload), checkedAt: row.checked_at }
      } catch {
        return
      }
    }
  }
  cache(id: string, payload: unknown, at: number) {
    if (this.available)
      this.sqlite
        .query(
          'INSERT INTO model_pricing_cache(id,payload,checked_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, checked_at=excluded.checked_at',
        )
        .run(id, JSON.stringify(payload), at)
  }
  snapshot(id: string, payload: unknown, at: number) {
    if (this.available)
      this.sqlite
        .query('INSERT INTO model_price_snapshots(id,payload,created_at) VALUES(?,?,?)')
        .run(id, JSON.stringify(payload), at)
  }
}
