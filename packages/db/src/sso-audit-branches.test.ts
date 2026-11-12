import { describe, expect, it } from 'vitest'
import { detailsCheck, detailsCheckMigrations, isSsoBranch } from './sso-audit-check-source.ts'

const migration = '0085_sso_audit_actions.sql'

describe('0085 SSO audit actions', () => {
  const migrations = detailsCheckMigrations()
  const previousFile = migrations[migrations.indexOf(migration) - 1] as string
  const previous = detailsCheck(previousFile)
  const current = detailsCheck(migration)
  // The statements after the CASE (the `NOT VALID` form and its `VALIDATE`), without comments.
  const statements = (tail: string) =>
    tail
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n')

  it('replaces the newest earlier check', () => {
    expect(migrations).toContain(migration)
    expect(previousFile < migration).toBe(true)
    expect(previous.branches.filter(isSsoBranch)).toEqual([])
  })

  it('keeps every earlier branch byte for byte and adds the SSO branches before the default', () => {
    expect(current.head).toBe(previous.head)
    expect(statements(current.tail)).toBe(statements(previous.tail))
    const added = current.branches.filter(isSsoBranch)
    expect(added.length).toBeGreaterThan(0)
    // Every other branch, comments included, in the same order.
    expect(current.branches.filter((branch) => !isSsoBranch(branch))).toEqual(previous.branches)
    // The SSO branches sit together right before the unchanged ELSE.
    const last = previous.branches.length - 1
    expect(current.branches.slice(0, last)).toEqual(previous.branches.slice(0, last))
    expect(current.branches.slice(last, last + added.length)).toEqual(added)
    expect(current.branches.at(-1)).toEqual(previous.branches.at(-1))
    expect(current.branches.at(-1)?.text).toBe("    ELSE details = '{}'::jsonb")
  })

  it('names only SSO actions in its own branches', () => {
    for (const branch of current.branches.filter(isSsoBranch)) {
      const list = /^ {4}WHEN action (?:= ('[^']+')|IN \(([^)]+)\)) THEN /.exec(branch.when)
      expect(list, branch.when).not.toBeNull()
      const names = (list?.[1] ?? list?.[2] ?? '').split(',')
      for (const name of names) expect(name).toMatch(/^'sso_[a-z_]+\.[a-z_]+'$/)
    }
  })
})
