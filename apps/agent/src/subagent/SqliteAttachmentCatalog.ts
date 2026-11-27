import { AgentError } from '../Domain'
import type { AgentDatabase } from '../storage/database/AgentDatabase'
import {
  inputAttachmentRows,
  inputAttachmentTable,
} from '../storage/repositories/InputAttachmentRepository'
import type {
  AttachmentBinding,
  AttachmentCatalog,
  AttachmentKind,
  AttachmentRecord,
} from './AttachmentService'

export class SqliteAttachmentCatalog implements AttachmentCatalog {
  constructor(private readonly db: AgentDatabase) {}

  async insertMany(records: readonly AttachmentRecord[]) {
    this.db.transaction(() => {
      for (const record of records) {
        this.db.sqlite
          .query(
            `INSERT INTO ${inputAttachmentTable(record.kind)} (id, thread_id, input_id, kind, name, media_type, size_bytes, sha256, storage_path, created_at, bound_at) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            record.id,
            record.kind,
            record.name,
            record.mimeType,
            record.size,
            record.sha256,
            record.sha256,
            record.createdAt,
          )
      }
    })
  }

  async get(id: string) {
    return this.row(id)
  }

  async getMany(ids: readonly string[]) {
    return ids.flatMap((id) => {
      const value = this.row(id)
      return value ? [value] : []
    })
  }

  async listByBinding(binding: AttachmentBinding) {
    if (binding.type !== 'input') return []
    const rows = this.db.sqlite
      .query(
        `SELECT id FROM ${inputAttachmentRows(this.db.sqlite)} WHERE input_id = ? ORDER BY created_at, id`,
      )
      .all(binding.id) as Array<{ id: string }>
    return rows.flatMap(({ id }) => {
      const value = this.row(id)
      return value ? [value] : []
    })
  }

  async bindMany(ids: readonly string[], binding: AttachmentBinding) {
    if (binding.type !== 'input')
      throw new AgentError('ATTACHMENT_BINDING_INVALID', '附件只能绑定到 input', 400)
    this.db.bindInputAttachments(binding.id, ids)
  }

  async unbindMany(ids: readonly string[], binding: AttachmentBinding) {
    if (binding.type !== 'input')
      throw new AgentError('ATTACHMENT_BINDING_INVALID', '附件只能绑定到 input', 400)
    this.db.unbindInputAttachments(binding.id, ids)
  }

  async removeMany(ids: readonly string[]) {
    this.db.transaction(() => {
      for (const id of ids) {
        const record = this.row(id)
        if (record)
          this.db.sqlite
            .query(`DELETE FROM ${inputAttachmentTable(record.kind)} WHERE id = ?`)
            .run(id)
      }
    })
  }

  async removeOrphans(createdBefore: number, limit: number) {
    const ids = (
      this.db.sqlite
        .query(
          `SELECT id FROM ${inputAttachmentRows(this.db.sqlite)} WHERE input_id IS NULL AND created_at <= ? ORDER BY created_at, id LIMIT ?`,
        )
        .all(createdBefore, limit) as Array<{ id: string }>
    ).map(({ id }) => id)
    const records = await this.getMany(ids)
    await this.removeMany(ids)
    return records
  }

  async countBySha256(sha256: string, kind: AttachmentKind) {
    const attachments = (
      this.db.sqlite
        .query(`SELECT COUNT(*) AS count FROM ${inputAttachmentTable(kind)} WHERE sha256 = ?`)
        .get(sha256) as { count: number }
    ).count
    if (kind === 'pdf') return attachments
    const projectSources = (
      this.db.profileSqlite
        .query(
          "SELECT COUNT(*) AS count FROM project_sources WHERE storage_kind = 'managed' AND sha256 = ?",
        )
        .get(sha256) as { count: number }
    ).count
    return attachments + projectSources
  }

  private row(id: string): AttachmentRecord | null {
    const row = this.db.sqlite
      .query(
        `SELECT id, input_id, kind, name, media_type, size_bytes, sha256, created_at FROM ${inputAttachmentRows(this.db.sqlite)} WHERE id = ?`,
      )
      .get(id) as Record<string, string | number | null> | null
    if (!row) return null
    return {
      id: String(row.id),
      kind: String(row.kind) as AttachmentRecord['kind'],
      name: String(row.name),
      mimeType: String(row.media_type),
      size: Number(row.size_bytes),
      sha256: String(row.sha256),
      createdAt: Number(row.created_at),
      binding: row.input_id == null ? null : { type: 'input', id: String(row.input_id) },
    }
  }
}
