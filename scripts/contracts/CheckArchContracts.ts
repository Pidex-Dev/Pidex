import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  evaluateArchContracts,
  formatArchContractReport,
  type ArchContractManifest,
} from './ArchContractsCore'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const MANIFEST_PATH = join(import.meta.dir, 'arch-contracts-manifest.json')

function sortRecord(record: Record<string, number>): Record<string, number> {
  const sorted: Record<string, number> = {}
  for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
    sorted[key] = record[key]
  }
  return sorted
}

function normalizeManifest(manifest: ArchContractManifest): ArchContractManifest {
  return {
    deprecatedBrandRatchet: sortRecord(manifest.deprecatedBrandRatchet ?? {}),
    useEffectRatchet: sortRecord(manifest.useEffectRatchet ?? {}),
    commentRatchet: sortRecord(manifest.commentRatchet ?? {}),
    bannedCommentRatchet: sortRecord(manifest.bannedCommentRatchet ?? {}),
  }
}

async function readManifest(path: string): Promise<ArchContractManifest> {
  const raw = await readFile(path, 'utf8')
  const parsed = JSON.parse(raw) as Partial<ArchContractManifest>
  return normalizeManifest({
    deprecatedBrandRatchet: parsed.deprecatedBrandRatchet ?? {},
    useEffectRatchet: parsed.useEffectRatchet ?? {},
    commentRatchet: parsed.commentRatchet ?? {},
    bannedCommentRatchet: parsed.bannedCommentRatchet ?? {},
  })
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))
  const updateBaseline = args.has('--update-baseline')

  if (updateBaseline) {
    const report = await evaluateArchContracts({ rootDir: REPO_ROOT })
    if (report.violations.length > 0) {
      console.error(formatArchContractReport(report))
      console.error('Refusing to update baseline while hard architectural violations exist.')
      process.exit(1)
    }
    const manifest = normalizeManifest(report.computedManifest)
    await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    console.log(`Updated ${MANIFEST_PATH}`)
    console.log(formatArchContractReport(report))
    return
  }

  let manifest: ArchContractManifest
  try {
    manifest = await readManifest(MANIFEST_PATH)
  } catch (error) {
    console.error(
      `Failed to read arch contracts manifest at ${MANIFEST_PATH}. Run with --update-baseline first.`,
    )
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  const report = await evaluateArchContracts({ rootDir: REPO_ROOT, manifest })
  const output = formatArchContractReport(report)
  if (report.violations.length > 0) {
    console.error(output)
    process.exit(1)
  }
  console.log(output)
}

await main()
