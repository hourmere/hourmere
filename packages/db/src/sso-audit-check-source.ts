// Reads the CASE branches of audit_events_details_check from the migration files, for the tests
// that compare 0085 with the previous check and bind its SSO branches to sso-audit.ts.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { migrationsDir } from './migrate.ts'

export interface DetailsCheckBranch {
  /** The `WHEN …`/`ELSE …` line. */
  when: string
  /** The comment lines above the branch, its first line and its continuation lines. */
  text: string
}

/** The details check that `file` adds: the text before its branches, the branches, the rest. */
export function detailsCheck(file: string): {
  head: string
  branches: DetailsCheckBranch[]
  tail: string
} {
  const sql = readFileSync(join(migrationsDir, file), 'utf8')
  const start = sql.indexOf(
    'ALTER TABLE audit_events DROP CONSTRAINT audit_events_details_check;\n',
  )
  const open = sql.indexOf('\n  CASE\n', start)
  const end = sql.indexOf('\n  END\n)', open)
  if (start < 0 || open < 0 || end < 0)
    throw new Error(`${file} does not replace audit_events_details_check`)
  const branches: DetailsCheckBranch[] = []
  let comments: string[] = []
  for (const line of sql.slice(open + '\n  CASE\n'.length, end).split('\n')) {
    const last = branches.at(-1)
    if (line.startsWith('    --')) comments.push(line)
    else if (line.startsWith('    WHEN ') || line.startsWith('    ELSE ')) {
      branches.push({ when: line, text: [...comments, line].join('\n') })
      comments = []
    } else if (line.startsWith('      ') && comments.length === 0 && last) last.text += `\n${line}`
    else throw new Error(`${file}: unexpected line in the details check: ${line}`)
  }
  if (comments.length) throw new Error(`${file}: unexpected details check layout`)
  return { head: sql.slice(start, open), branches, tail: sql.slice(end) }
}

/** Migrations that replace the details check, oldest first; the last is what every install has. */
export function detailsCheckMigrations(): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .filter((name) =>
      readFileSync(join(migrationsDir, name), 'utf8').includes(
        'ALTER TABLE audit_events DROP CONSTRAINT audit_events_details_check;',
      ),
    )
}

/** Whether a branch is one of the SSO action branches. */
export const isSsoBranch = (branch: DetailsCheckBranch) =>
  /\baction (?:= |IN \()'sso_/.test(branch.when)
