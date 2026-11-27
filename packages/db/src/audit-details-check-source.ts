// Reads audit_events_details_check from migration source for the branch and catalogue tests.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { migrationsDir } from './migrate.ts'

const detailsCheck = /\bCONSTRAINT\s+"?audit_events_details_check"?\s+CHECK\s*\(/gi
const touchesDetailsCheck =
  /\b(?:CONSTRAINT\s+(?:IF\s+EXISTS\s+)?|TO\s+)"?audit_events_details_check\b/i

function maskComments(sql: string): string {
  return sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\r\n]/g, ' '))
}

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
  const definitions = [...maskComments(sql).matchAll(detailsCheck)]
  const start = definitions[0]?.index
  if (start === undefined) throw new Error(`${file} does not add audit_events_details_check`)
  if (definitions.length !== 1)
    throw new Error(`${file}: expected exactly one definition of audit_events_details_check`)
  const lines = sql.slice(start).split(/\r?\n/)
  const open = lines.findIndex((line) => /^\s+CASE\b/.test(line))
  const indent = lines[open]?.match(/^( +)CASE$/)?.[1]
  if (!indent)
    throw new Error(`${file}: expected a searched CASE to verify audit details branch retention`)
  const branchIndent = `${indent}  `
  const close = lines.indexOf(`${indent}END`, open + 1)
  const closingLine = lines[close + 1]?.trim()
  if (close < 0 || !closingLine || !/^\)(?:,|(?: NOT VALID)?;)$/.test(closingLine)) {
    throw new Error(`${file}: expected the CHECK to end after the audit details CASE`)
  }
  const branches: DetailsCheckBranch[] = []
  let comments: string[] = []
  for (const line of lines.slice(open + 1, close)) {
    const last = branches.at(-1)
    if (line.startsWith(`${branchIndent}--`)) comments.push(line)
    else if (line.startsWith(`${branchIndent}WHEN `) || line.startsWith(`${branchIndent}ELSE `)) {
      branches.push({ when: line, text: [...comments, line].join('\n') })
      comments = []
    } else if (line.startsWith(`${branchIndent}  `) && comments.length === 0 && last) {
      last.text += `\n${line}`
    } else throw new Error(`${file}: unexpected line in the details check: ${line}`)
  }
  if (comments.length) throw new Error(`${file}: unexpected details check layout`)
  const tail = `\n${lines.slice(close).join('\n')}`
  return {
    head: lines.slice(0, open + 1).join('\n'),
    branches,
    tail: tail.slice(0, tail.indexOf(';') + 1),
  }
}

/** Migrations that name the details constraint in DDL, in migration order. */
export function detailsCheckMigrationHistory(
  before?: string,
): { file: string; defines: boolean }[] {
  return readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .filter((name) => before === undefined || name < before)
    .sort()
    .flatMap((file) => {
      const sql = maskComments(readFileSync(join(migrationsDir, file), 'utf8'))
      return touchesDetailsCheck.test(sql) ? [{ file, defines: sql.search(detailsCheck) >= 0 }] : []
    })
}

/** The latest details check migration, optionally from before a given migration. */
export function latestDetailsCheckMigration(before?: string): string {
  const file = detailsCheckMigrationHistory(before).findLast(({ defines }) => defines)?.file
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
