import type { Database } from 'bun:sqlite'

const standardTable = 'input_attachments'
const pdfTable = 'input_pdf_attachments'
const columns =
  'id, thread_id, input_id, kind, name, media_type, size_bytes, sha256, storage_path, created_at, bound_at'

export const hasInputPdfAttachments = (db: Database) =>
  Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(pdfTable))

export const inputAttachmentTables = (db: Database) =>
  hasInputPdfAttachments(db) ? ([standardTable, pdfTable] as const) : ([standardTable] as const)

export const inputAttachmentRows = (db: Database, includePdf = true) =>
  includePdf && hasInputPdfAttachments(db)
    ? `(SELECT ${columns} FROM ${standardTable} UNION ALL SELECT ${columns} FROM ${pdfTable})`
    : standardTable

export const inputAttachmentTable = (kind: string) => (kind === 'pdf' ? pdfTable : standardTable)

export const INPUT_PDF_ATTACHMENT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${pdfTable} (
    id TEXT PRIMARY KEY,
    thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
    input_id TEXT REFERENCES inputs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind = 'pdf'),
    name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    bound_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS input_pdf_attachments_input ON ${pdfTable}(input_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS input_pdf_attachments_thread ON ${pdfTable}(thread_id, created_at)`,
]
