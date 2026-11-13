// Binds the SSO branches of audit_events_details_check (the newest migration that replaces it)
// to the application catalogue in sso-audit.ts: the same actions, keys, required keys and value
// lists in the text, and the same verdicts on a migrated database for details built from the
// catalogue. Changing either side alone fails.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  SSO_AUDIT_ID,
  SSO_AUDIT_MAX_REVISION,
  SSO_AUDIT_METHODS,
  SSO_AUDIT_REASONS,
  type SsoAuditAction,
  type SsoAuditDetailKey,
  ssoAuditDetails,
} from './sso-audit.ts'
import { detailsCheck, detailsCheckMigrations, isSsoBranch } from './sso-audit-check-source.ts'
import { ssoAuditTestId } from './sso-audit-protections.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const actions = Object.keys(ssoAuditDetails) as SsoAuditAction[]
const spec = (action: SsoAuditAction) =>
  ssoAuditDetails[action] as {
    required: readonly SsoAuditDetailKey[]
    optional: readonly SsoAuditDetailKey[]
    outcomes?: readonly string[]
  }
const ssoKeys: SsoAuditDetailKey[] = [
  'method',
  'providerId',
  'revision',
  'outcome',
  'reason',
  'correlationId',
]
const quoted = (list: string) =>
  list.split(',').map((item) => {
    const match = /^\s*'([^']*)'\s*$/.exec(item)
    if (!match) throw new Error(`Not a quoted list item: ${item}`)
    return match[1] as string
  })

interface ParsedBranch {
  actions: string[]
  keys: string[]
  optional: string[]
  text: string
}
function parse(text: string, when: string): ParsedBranch {
  const head =
    /^ {4}WHEN action (?:= '([^']+)'|IN \(([^)]+)\)) THEN details - (?:'([a-zA-Z]+)'|ARRAY\[([^\]]+)\]) = '\{\}'::jsonb$/.exec(
      when,
    )
  if (!head) throw new Error(`Unexpected SSO branch head: ${when}`)
  return {
    actions: head[1] ? [head[1]] : quoted(head[2] as string),
    keys: head[3] ? [head[3]] : quoted(head[4] as string),
    optional: [...text.matchAll(/\(NOT details \? '([a-zA-Z]+)' OR /g)].map((m) => m[1] as string),
    text,
  }
}
const ssoBranches = () => {
  const file = detailsCheckMigrations().at(-1) as string
  return detailsCheck(file)
    .branches.filter(isSsoBranch)
    .map((b) => parse(b.text, b.when))
}
/** The value check the SQL applies to one key, as text. */
const inList = (text: string, key: string) =>
  [...text.matchAll(new RegExp(`details->>'${key}' IN \\(((?:'[a-z_]+',?\\s*)+)\\)`, 'g'))].map(
    (match) => quoted((match[1] as string).replace(/\s+/g, ' ')),
  )
const patterns = (text: string, key: string) =>
  [...text.matchAll(new RegExp(`details->>'${key}' ~ '([^']+)'`, 'g'))].map((m) => m[1])

describe('SSO audit details: database check bound to the catalogue', () => {
  const branches = ssoBranches()

  it('lists every keyed SSO action once, with its exact required and optional keys', () => {
    const listed = branches.flatMap((branch) => branch.actions)
    expect(new Set(listed).size).toBe(listed.length)
    const keyed = actions.filter(
      (action) => spec(action).required.length + spec(action).optional.length > 0,
    )
    expect([...listed].sort()).toEqual([...keyed].sort())
    // The others take no details and fall to the empty-details default.
    for (const action of actions.filter((action) => !keyed.includes(action)))
      expect(listed).not.toContain(action)
    for (const branch of branches)
      for (const action of branch.actions as SsoAuditAction[]) {
        expect([...branch.keys].sort(), action).toEqual(
          [...spec(action).required, ...spec(action).optional].sort(),
        )
        expect([...branch.optional].sort(), action).toEqual([...spec(action).optional].sort())
      }
  })

  it('checks each key with the catalogue values', () => {
    for (const branch of branches) {
      const action = branch.actions[0] as SsoAuditAction
      for (const key of ssoKeys) {
        const present = branch.keys.includes(key)
        const methods = inList(branch.text, 'method')
        const reasons = inList(branch.text, 'reason')
        const outcomes = inList(branch.text, 'outcome')
        if (key === 'method') expect(methods).toEqual(present ? [[...SSO_AUDIT_METHODS]] : [])
        if (key === 'reason') expect(reasons).toEqual(present ? [[...SSO_AUDIT_REASONS]] : [])
        if (key === 'outcome')
          expect(outcomes).toEqual(present ? [[...(spec(action).outcomes ?? [])]] : [])
        if (key === 'providerId' || key === 'correlationId')
          expect(patterns(branch.text, key)).toEqual(present ? [SSO_AUDIT_ID.source] : [])
        if (key === 'revision') {
          const revision = [
            ...branch.text.matchAll(
              /details->>'revision' ~ '\^\[1-9\]\[0-9\]\{0,9\}\$'\n {8}THEN \(details->>'revision'\)::bigint <= (\d+) ELSE false END/g,
            ),
          ].map((m) => Number(m[1]))
          expect(revision).toEqual(present ? [SSO_AUDIT_MAX_REVISION] : [])
        }
      }
      // Every branch with an outcome, reason or ID check names the same key in its allow-list.
      for (const [, key] of branch.text.matchAll(/details->'([a-zA-Z]+)'/g))
        expect(branch.keys).toContain(key)
    }
  })
})

describe.skipIf(!serverUrl)('SSO audit details: database verdicts follow the catalogue', () => {
  let owned: TestDatabase
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  const insert = (action: string, details: unknown) =>
    owned.pool.query(
      `INSERT INTO audit_events (actor_type, actor_id, credential_type, action, target_type, target_id, details)
       VALUES ('system', 'binding', 'none', $1, 'binding', $2, $3::jsonb)`,
      [action, randomUUID(), JSON.stringify(details)],
    )
  const valid = (action: SsoAuditAction, key: SsoAuditDetailKey): unknown[] =>
    ({
      method: [...SSO_AUDIT_METHODS],
      providerId: [ssoAuditTestId()],
      revision: [1, SSO_AUDIT_MAX_REVISION],
      outcome: [...(spec(action).outcomes ?? [])],
      reason: [...SSO_AUDIT_REASONS],
      correlationId: [ssoAuditTestId()],
    })[key]

  it('accepts what the catalogue allows and refuses everything it does not', async () => {
    const refused = { code: '23514', constraint: 'audit_events_details_check' }
    for (const action of actions) {
      const { required, optional } = spec(action)
      const full = Object.fromEntries(
        [...required, ...optional].map((key) => [key, valid(action, key)[0]]),
      )
      const minimal = Object.fromEntries(required.map((key) => [key, valid(action, key)[0]]))
      await expect(insert(action, full), action).resolves.toMatchObject({ rowCount: 1 })
      await expect(insert(action, minimal), action).resolves.toMatchObject({ rowCount: 1 })
      for (const key of [...required, ...optional])
        for (const value of valid(action, key))
          await expect(
            insert(action, { ...full, [key]: value }),
            `${action} ${key}`,
          ).resolves.toMatchObject({
            rowCount: 1,
          })
      for (const key of required) {
        const { [key]: _, ...rest } = full
        await expect(insert(action, rest), `${action} without ${key}`).rejects.toMatchObject(
          refused,
        )
      }
      for (const key of ssoKeys.filter(
        (key) => !(required as string[]).includes(key) && !(optional as string[]).includes(key),
      ))
        await expect(
          insert(action, { ...full, [key]: valid('sso_provider.tested', key)[0] }),
          `${action} with ${key}`,
        ).rejects.toMatchObject(refused)
    }
  }, 120_000)
})
