import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { createRoute, z } from '@hono/zod-openapi'
import {
  createTestDatabase,
  reuseConnectionsAfterErrors,
  type TestDatabase,
} from '@hourmere/db/testing'
import { DomainError } from '@hourmere/scheduling'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { migrationsDir } from '../../../packages/db/src/migrate.ts'
import {
  freshProofValues,
  type IdentityFixture,
  identityFixture,
  linkValues,
  mailboxOf,
} from '../../../packages/db/src/sso-identity-fixtures.ts'
import {
  at,
  insert,
  oidcProviderValues,
  quote,
} from '../../../packages/db/src/sso-storage-fixtures.ts'
import { createApp } from './app.ts'
import {
  SSO_STORAGE_DIAGNOSTIC_OMITTED,
  SSO_STORAGE_SHARED_RULES,
  SSO_STORAGE_TABLES,
  ssoStorageDiagnostic,
} from './sso-storage-errors.ts'

const serverUrl = process.env.DATABASE_URL
const OMITTED = SSO_STORAGE_DIAGNOSTIC_OMITTED
const STORAGE_MIGRATIONS = ['0074_sso_configuration.sql', '0075_sso_identity.sql']

/** A distinctive value that is no UUID, so the general log redaction cannot hide it. */
const marker = (label: string) => `private-${label}-${randomBytes(6).toString('hex')}`

/** A driver-shaped error, as node-pg raises it. */
const driverError = (fields: Record<string, unknown>) =>
  Object.assign(new Error('new row violates a constraint'), fields)

describe('SSO storage database errors are recognised by their names only', () => {
  const mailbox = 'private-person@example.test'
  const linkError = () =>
    driverError({
      code: '23514',
      table: 'sso_identity_links',
      constraint: 'sso_identity_links_subject',
      detail: `Failing row contains (${mailbox})`,
      hint: mailbox,
      where: mailbox,
      parameters: [mailbox],
    })
  const linkDiagnostic = [
    OMITTED,
    'code=23514',
    'table=sso_identity_links',
    'constraint=sso_identity_links_subject',
  ].join(' ')

  it('keeps only the SQLSTATE, table and constraint names', () => {
    const text = ssoStorageDiagnostic(linkError())
    expect(text).toBe(linkDiagnostic)
    expect(text).not.toContain(mailbox)
    expect(text).not.toContain('Failing row')
    expect(text).not.toContain('violates')
  })

  it('recognises a table or a constraint of either storage, on plain objects too', () => {
    for (const table of ['sso_policies', 'sso_recovery_owners', 'sso_attempts', 'sso_replay_cache'])
      expect(ssoStorageDiagnostic({ code: '23502', table, column: 'x' }), table).toBe(
        `${OMITTED} code=23502 table=${table}`,
      )
    for (const constraint of [
      'sso_identity_links_live_identity',
      'sso_providers_configuration_envelope',
      'sso_domains_challenge_digest',
      'sso_provider_domains_pkey',
      'sso_attempts',
      'sso_team_organization',
      'sso_recovery_current_owner',
      'sso_reliance_link',
    ])
      expect(ssoStorageDiagnostic({ code: '23505', constraint }), constraint).toBe(
        `${OMITTED} code=23505 constraint=${constraint}`,
      )
  })

  it('finds the database error in a cause chain or an AggregateError', () => {
    const expected = linkDiagnostic
    expect(ssoStorageDiagnostic(new Error('outer', { cause: linkError() }))).toBe(expected)
    expect(
      ssoStorageDiagnostic(new Error('a', { cause: new Error('b', { cause: linkError() }) })),
    ).toBe(expected)
    expect(ssoStorageDiagnostic(new AggregateError([new Error('first'), linkError()]))).toBe(
      expected,
    )
    expect(
      ssoStorageDiagnostic(new Error('outer', { cause: new AggregateError([linkError()]) })),
    ).toBe(expected)
    expect(ssoStorageDiagnostic({ cause: { errors: [{ cause: linkError() }] } })).toBe(expected)
  })

  it('terminates on cycles and bounds the walk', () => {
    const first: Record<string, unknown> = {}
    const second: Record<string, unknown> = { cause: first }
    first.cause = second
    expect(ssoStorageDiagnostic(first)).toBeUndefined()
    second.errors = [first, second, linkError()]
    expect(ssoStorageDiagnostic(first)).toMatch(/^\[private SSO storage diagnostic omitted\] /)
    const looping = new AggregateError([])
    looping.errors.push(looping)
    expect(ssoStorageDiagnostic(looping)).toBeUndefined()
    let deep: unknown = linkError()
    for (let level = 0; level < 20; level += 1) deep = { cause: deep }
    expect(ssoStorageDiagnostic(deep)).toBeUndefined()
  })

  it('leaves other errors, other tables and malformed fields alone', () => {
    for (const value of [
      undefined,
      null,
      'sso_attempts',
      23514,
      new Error('sso_attempts_mailbox'),
      { code: '23514', table: 'webhooks', constraint: 'webhooks_url_check' },
      { code: '23514', table: 'ssofoo', constraint: 'ssofoo_check' },
      { code: '23514', table: 'sso_attemptsx', constraint: 'sso_attemptsx_check' },
      { code: '23514', table: 'scim_membership_blocks', constraint: 'scim_membership_blocks_x' },
      { code: '23514', table: 'SSO_ATTEMPTS' },
      { code: 'ECONNREFUSED', table: 'sso_attempts' },
      { code: 23514, table: 'sso_attempts' },
      { table: 'sso_attempts', constraint: 'sso_attempts_kind' },
      { code: '23514', message: 'violates "sso_attempts_kind"' },
    ])
      expect(ssoStorageDiagnostic(value), inspect(value)).toBeUndefined()
    // Recognised, but a value that is not identifier-shaped is dropped, not logged.
    expect(
      ssoStorageDiagnostic({
        code: '23514',
        table: 'sso_attempts',
        constraint: `sso_attempts_kind ${mailbox}`,
      }),
    ).toBe(`${OMITTED} code=23514 table=sso_attempts`)
    expect(ssoStorageDiagnostic({ code: '2 514', constraint: 'sso_attempts_kind', table: 7 })).toBe(
      `${OMITTED} constraint=sso_attempts_kind`,
    )
  })

  it('never throws', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('unreadable')
        },
      },
    )
    expect(ssoStorageDiagnostic(hostile)).toBeUndefined()
    expect(ssoStorageDiagnostic({ errors: [hostile, linkError()] })).toMatch(/^\[private SSO/)
    const getter = Object.defineProperty({}, 'cause', {
      get() {
        throw new Error('unreadable')
      },
    })
    expect(ssoStorageDiagnostic(getter)).toBeUndefined()
  })
})

type Statement = { text: string; values: unknown[] }
interface ViolationCase {
  name: string
  statement: Statement
  code: string
  /** The table PostgreSQL reports; a trigger's RAISE reports none. */
  table: string | undefined
  constraint: string | undefined
  /** What the driver's error repeats from the row or key and the log must not. */
  leaks: string[]
}

const insertStatement = (table: string, values: Record<string, unknown>): Statement => {
  const fields = Object.keys(values)
  return {
    text: `INSERT INTO ${quote(table)} (${fields.map(quote).join(',')})
      VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')})`,
    values: Object.values(values),
  }
}

/** The fields of a caught driver error that the diagnostic may keep. */
function namesOf(error: unknown) {
  const { code, table, constraint } = error as Record<string, unknown>
  return { code, table, constraint }
}

function captureConsole() {
  const lines: string[] = []
  const record = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg))).join(' '))
  }
  const spies = [
    vi.spyOn(console, 'error').mockImplementation(record),
    vi.spyOn(console, 'warn').mockImplementation(record),
    vi.spyOn(console, 'log').mockImplementation(record),
  ]
  return {
    lines,
    restore: () => {
      for (const spy of spies) spy.mockRestore()
    },
  }
}

const wraps = ['raw', 'domain', 'cause'] as const
type Wrap = (typeof wraps)[number]

describe.skipIf(!serverUrl)('SSO storage database errors in the error log', () => {
  let owned: TestDatabase
  let db: pg.Pool
  let f: IdentityFixture
  const cases = new Map<string, ViolationCase>()
  let ordinary: ViolationCase

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'sso_log' })
    db = reuseConnectionsAfterErrors(owned.pool)
    const client = await owned.pool.connect()
    const linkedSubject = marker('subject')
    const linkedMailbox = mailboxOf('private-linked')
    try {
      await client.query('BEGIN')
      f = await identityFixture(client)
      // A live link whose subject a second link then repeats.
      await insert(client, 'sso_identity_links', {
        ...linkValues(f, f.admin),
        subject: linkedSubject,
        proven_email: linkedMailbox,
      })
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    const longSubject = `${marker('long-subject')}${'s'.repeat(1100)}`
    const linkMailbox = mailboxOf('private-link')
    const attemptMailbox = mailboxOf('private-attempt')
    const nullMailbox = mailboxOf('private-null')
    const issuer = `https://${marker('issuer')}.example.test/v2.0`
    for (const violation of [
      {
        // A refused link row: the detail repeats it, proven mailbox included.
        name: 'link_subject',
        statement: insertStatement('sso_identity_links', {
          ...linkValues(f, f.owner),
          subject: longSubject,
          proven_email: linkMailbox,
        }),
        code: '23514',
        table: 'sso_identity_links',
        constraint: 'sso_identity_links_subject',
        leaks: [linkMailbox, longSubject.slice(0, 40)],
      },
      {
        // A refused attempt row: the detail repeats the attempt's mailbox.
        name: 'attempt_lifetime',
        statement: insertStatement('sso_attempts', {
          ...freshProofValues(f),
          mailbox: attemptMailbox,
          expires_at: at(900),
        }),
        code: '23514',
        table: 'sso_attempts',
        constraint: 'sso_attempts_lifetime',
        leaks: [attemptMailbox],
      },
      {
        // A NOT NULL refusal is recognised by its table.
        name: 'attempt_not_null',
        statement: insertStatement('sso_attempts', {
          ...freshProofValues(f),
          mailbox: nullMailbox,
          operation: null,
        }),
        code: '23502',
        table: 'sso_attempts',
        constraint: undefined,
        leaks: [nullMailbox],
      },
      {
        // A second live link for the same subject: the detail repeats the key.
        name: 'live_identity',
        statement: insertStatement('sso_identity_links', {
          ...linkValues(f, f.coOwner),
          subject: linkedSubject,
        }),
        code: '23505',
        table: 'sso_identity_links',
        constraint: 'sso_identity_links_live_identity',
        leaks: [linkedSubject],
      },
      {
        // Configuration storage: the detail repeats the issuer and the sealed configuration.
        name: 'provider_text',
        statement: insertStatement('sso_providers', {
          ...oidcProviderValues(f.team),
          display_name: '',
          issuer,
        }),
        code: '23514',
        table: 'sso_providers',
        constraint: 'sso_providers_text',
        leaks: [issuer],
      },
      {
        // A rule a trigger raises names no table; its message is omitted as well.
        name: 'team_rule',
        statement: insertStatement('sso_policies', { organization_id: f.personal }),
        code: '23514',
        table: undefined,
        constraint: 'sso_team_organization',
        leaks: ['personal organization'],
      },
    ] satisfies ViolationCase[])
      cases.set(violation.name, violation)

    const url = `https://${marker('ordinary')}.example.test/${'u'.repeat(2100)}`
    ordinary = {
      name: 'ordinary',
      statement: insertStatement('webhooks', {
        organization_id: f.team,
        url,
        events: ['booking.created'],
        secret_ciphertext: Buffer.from([1, 2, 3]),
      }),
      code: '23514',
      table: 'webhooks',
      constraint: 'webhooks_url_check',
      leaks: [url.slice(0, 40)],
    }
    cases.set(ordinary.name, ordinary)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  /** Runs the case's statement and returns the driver's error. */
  async function violate(violation: ViolationCase): Promise<unknown> {
    const error = await db.query(violation.statement.text, violation.statement.values).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error, violation.name).toBeDefined()
    return error
  }

  function app() {
    return createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      publicUrl: 'http://localhost',
      routes: [
        ({ app }) =>
          app.openapi(
            createRoute({
              method: 'get',
              path: '/api/v1/storage-test/{name}/{wrap}',
              request: { params: z.object({ name: z.string(), wrap: z.enum(wraps) }) },
              responses: { 200: { description: 'The statement was accepted' } },
            }),
            async (c) => {
              const { name, wrap } = c.req.valid('param')
              const violation = cases.get(name)
              if (!violation) throw new Error('unknown case')
              const error = await violate(violation)
              if (wrap === 'domain')
                throw new DomainError('conflict', 'storage_test_conflict', undefined, {
                  cause: error,
                })
              if (wrap === 'cause') throw new Error('x', { cause: error })
              throw error
            },
          ),
      ],
    })
  }

  async function logged(violation: ViolationCase, wrap: Wrap) {
    const capture = captureConsole()
    try {
      const response = await app().request(`/api/v1/storage-test/${violation.name}/${wrap}`)
      const body: unknown = await response.json()
      const errors = capture.lines.flatMap((line) => line.split(' ERROR ').slice(1))
      return { response, body, errors, log: capture.lines.join('\n') }
    } finally {
      capture.restore()
    }
  }

  const expectedStatus = (wrap: Wrap) =>
    wrap === 'domain'
      ? { status: 409, body: { error: 'storage_test_conflict' } }
      : { status: 500, body: { error: 'internal_error' } }
  const label = (wrap: Wrap) => (wrap === 'domain' ? 'storage_test_conflict caused by ' : '')

  it('recognises every name of the SSO storage tables and no other table', async () => {
    const sources = await Promise.all(
      STORAGE_MIGRATIONS.map((file) => readFile(join(migrationsDir, file), 'utf8')),
    )
    const created = sources.flatMap((source) =>
      [...source.matchAll(/^CREATE TABLE (\w+) \(/gm)].map(([, table]) => table),
    )
    expect(created.sort()).toEqual([...SSO_STORAGE_TABLES].sort())
    // Every rule a storage trigger raises names itself as the error's constraint.
    const rules = sources.flatMap((source) =>
      [...source.matchAll(/CONSTRAINT = '([a-z_]+)'/g)].map(([, rule]) => rule ?? ''),
    )
    expect(rules.length).toBeGreaterThan(60)
    const recognised = (name: string) =>
      ssoStorageDiagnostic({ code: '23514', constraint: name }) !== undefined
    expect(rules.filter((rule) => !recognised(rule))).toEqual([])
    // The explicit list holds exactly the rules that do not start with their table's name.
    const unprefixed = rules.filter(
      (rule) => ![...SSO_STORAGE_TABLES].some((table) => rule.startsWith(`${table}_`)),
    )
    expect([...new Set(unprefixed)].sort()).toEqual([...SSO_STORAGE_SHARED_RULES].sort())

    // Every constraint, index and trigger in the migrated database, by table.
    const { rows } = await owned.pool.query<{ table: string; name: string }>(
      `WITH relations AS (
        SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
      )
      SELECT r.relname AS table, k.conname AS name FROM pg_constraint k
        JOIN relations r ON r.oid = k.conrelid
      UNION ALL
      SELECT r.relname, i.relname FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
        JOIN relations r ON r.oid = x.indrelid
      UNION ALL
      SELECT r.relname, t.tgname FROM pg_trigger t JOIN relations r ON r.oid = t.tgrelid
      WHERE NOT t.tgisinternal`,
    )
    const storageNames = rows.filter(({ table }) => SSO_STORAGE_TABLES.has(table))
    expect(new Set(storageNames.map(({ table }) => table))).toEqual(SSO_STORAGE_TABLES)
    expect(storageNames.length).toBeGreaterThan(150)
    expect(rows.length).toBeGreaterThan(storageNames.length + 300)
    const mismatched = rows
      .filter(({ table, name }) => recognised(name) !== SSO_STORAGE_TABLES.has(table))
      .map(({ table, name }) => `${table}.${name}`)
    expect(mismatched).toEqual([])
    // A later migration that adds an SSO table must add it to the recogniser too.
    const { rows: ssoTables } = await owned.pool.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND c.relname LIKE 'sso\\_%'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
    )
    expect(ssoTables.map(({ name }) => name).sort()).toEqual([...SSO_STORAGE_TABLES].sort())
  })

  it.each([
    'link_subject',
    'attempt_lifetime',
    'attempt_not_null',
    'live_identity',
    'provider_text',
    'team_rule',
  ])('omits the diagnostic of %s, raw and wrapped', async (name) => {
    const violation = cases.get(name)
    if (!violation) throw new Error(`Missing case ${name}`)
    // Control: the driver's error repeats the private values, so logging it would leak them.
    const error = await violate(violation)
    expect(namesOf(error)).toEqual({
      code: violation.code,
      table: violation.table,
      constraint: violation.constraint,
    })
    const unredacted = inspect(error, { breakLength: Number.POSITIVE_INFINITY })
    for (const leak of violation.leaks) expect(unredacted).toContain(leak)
    const names = [
      `code=${violation.code}`,
      ...(violation.table ? [`table=${violation.table}`] : []),
      ...(violation.constraint ? [`constraint=${violation.constraint}`] : []),
    ].join(' ')

    for (const wrap of wraps) {
      const { response, body, errors, log } = await logged(violation, wrap)
      const expected = expectedStatus(wrap)
      expect(response.status, wrap).toBe(expected.status)
      expect(body, wrap).toEqual(expected.body)
      for (const leak of violation.leaks) expect(log, wrap).not.toContain(leak)
      expect(log, wrap).not.toContain('Failing row')
      expect(log, wrap).not.toContain('already exists')
      expect(log, wrap).not.toContain('@example.test')
      // One error line: the label, the marker and the names, nothing else.
      expect(errors, wrap).toEqual([
        `GET /api/v1/storage-test/${name}/${wrap}: ${label(wrap)}${OMITTED} ${names}`,
      ])
    }
  })

  it('still logs the diagnostic of an ordinary table', async () => {
    const error = await violate(ordinary)
    expect(namesOf(error)).toEqual({
      code: '23514',
      table: 'webhooks',
      constraint: 'webhooks_url_check',
    })
    expect(ssoStorageDiagnostic(error)).toBeUndefined()
    for (const wrap of wraps) {
      const { response, body, errors, log } = await logged(ordinary, wrap)
      const expected = expectedStatus(wrap)
      expect(response.status, wrap).toBe(expected.status)
      expect(body, wrap).toEqual(expected.body)
      expect(errors, wrap).toHaveLength(1)
      expect(errors[0], wrap).toContain('Failing row contains')
      expect(log, wrap).toContain('webhooks_url_check')
      for (const leak of ordinary.leaks) expect(log, wrap).toContain(leak)
      expect(log, wrap).not.toContain(OMITTED)
    }
  })
})
