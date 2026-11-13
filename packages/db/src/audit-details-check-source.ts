// Reads the CASE branches of audit_events_details_check from the migration files, for the
// tests that compare 0080 with 0078 and bind the event catalogues to the code.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { migrationsDir } from './migrate.ts'

export interface DetailsCheckBranch {
  /** The `WHEN …`/`ELSE …` line. */
  when: string
  /** The comment lines above the branch, its first line and its continuation lines. */
  text: string
}

/** The details check that `file` adds: its branches in order, and the text around them. */
export function detailsCheckBranches(file: string): {
  head: string
  branches: DetailsCheckBranch[]
  tail: string
} {
  const sql = readFileSync(join(migrationsDir, file), 'utf8')
  const start = sql.indexOf('CONSTRAINT audit_events_details_check CHECK (\n')
  const end = sql.indexOf('\n  END\n)', start)
  if (start < 0 || end < 0) throw new Error(`${file} does not add audit_events_details_check`)
  const lines = sql.slice(start, end).split('\n')
  const open = lines.indexOf('  CASE')
  const branches: DetailsCheckBranch[] = []
  let comments: string[] = []
  for (const line of lines.slice(open + 1)) {
    const last = branches.at(-1)
    if (line.startsWith('    --')) comments.push(line)
    else if (line.startsWith('    WHEN ') || line.startsWith('    ELSE ')) {
      branches.push({ when: line, text: [...comments, line].join('\n') })
      comments = []
    } else if (line.startsWith('      ') && comments.length === 0 && last) last.text += `\n${line}`
    else throw new Error(`${file}: unexpected line in the details check: ${line}`)
  }
  if (open < 0 || comments.length) throw new Error(`${file}: unexpected details check layout`)
  return {
    head: lines.slice(0, open + 1).join('\n'),
    branches,
    tail: sql.slice(end, sql.indexOf(';', end) + 1),
  }
}

/** The newest migration that (re)creates the details check: the one every install ends with. */
export function latestDetailsCheckMigration(): string {
  const file = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .filter((name) =>
      readFileSync(join(migrationsDir, name), 'utf8').includes(
        'CONSTRAINT audit_events_details_check CHECK (',
      ),
    )
    .at(-1)
  if (!file) throw new Error('No migration creates audit_events_details_check')
  return file
}

/** The branch for the actions whose list starts with `firstAction`. */
export function destinationBranch(branches: DetailsCheckBranch[], firstAction: string) {
  const found = branches.filter((branch) =>
    branch.when.startsWith(`    WHEN action IN ('${firstAction}',`),
  )
  if (found.length !== 1) throw new Error(`Expected one details check branch for ${firstAction}`)
  return found[0] as DetailsCheckBranch
}
