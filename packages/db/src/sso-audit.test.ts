import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type AuditEvent,
  auditDetails,
  type SsoAuditEvent,
  type SsoSecurityFailure,
  ssoSecurityFailureScope,
  withAuditRequest,
  writeAuditEvent,
  writeSsoAuditEvent,
  writeSsoSecurityFailure,
} from './audit.ts'
import { createDb, type Db } from './index.ts'
import {
  SSO_AUDIT_LIMITS,
  SSO_AUDIT_REASONS,
  SSO_SECURITY_FAILURE_ACTIONS,
  type SsoAuditAction,
  type SsoAuditDetailKey,
  type SsoChangeAction,
  ssoAuditDetails,
} from './sso-audit.ts'
import { ssoAuditTestId, ssoSensitiveValues } from './sso-audit-protections.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const actions = Object.keys(ssoAuditDetails) as SsoAuditAction[]
const changeActions = actions.filter(
  (action) => !(SSO_SECURITY_FAILURE_ACTIONS as readonly string[]).includes(action),
) as SsoChangeAction[]
const spec = (action: SsoAuditAction) =>
  ssoAuditDetails[action] as {
    required: readonly SsoAuditDetailKey[]
    optional: readonly SsoAuditDetailKey[]
    outcomes?: readonly string[]
  }
const keysOf = (action: SsoAuditAction) => [...spec(action).required, ...spec(action).optional]
const sensitive = Object.values(ssoSensitiveValues)

function valuesFor(action: SsoAuditAction): Record<SsoAuditDetailKey, unknown> {
  return {
    method: 'saml',
    providerId: ssoAuditTestId(),
    revision: 12,
    outcome: spec(action).outcomes?.[0],
    reason: 'signature_invalid',
    correlationId: ssoAuditTestId(),
  }
}
/** Every key the action takes (`full`) or only its required keys. */
function detailsFor(action: SsoAuditAction, full: boolean): Record<string, unknown> {
  const values = valuesFor(action)
  const keys = full ? keysOf(action) : spec(action).required
  return Object.fromEntries(keys.map((key) => [key, values[key]]))
}
/** Unsafe values for each key; every one is refused by the application and the database. */
const unsafe: Record<SsoAuditDetailKey, unknown[]> = {
  method: ['OIDC', 'ldap', '', 1, null, ['oidc'], ssoSensitiveValues.token],
  providerId: [
    ssoSensitiveValues.subjectGuid,
    randomUUID(),
    ssoAuditTestId().toUpperCase(),
    `${ssoAuditTestId()}\n`,
    ssoSensitiveValues.subjectText,
    ssoSensitiveValues.mailboxCapability,
    null,
    7,
  ],
  revision: [0, -1, 1.5, '1', 2_147_483_648, Number.NaN, null, true],
  outcome: ['ok', 'PASSED', ssoSensitiveValues.token, null, 1],
  reason: [
    ssoSensitiveValues.token,
    ssoSensitiveValues.encodedAssertion,
    ssoSensitiveValues.secret,
    'Signature_Invalid',
    'signature_invalid ',
    'invalid_grant: the code was already redeemed',
    null,
    ['unclassified'],
  ],
  correlationId: [
    ssoSensitiveValues.subjectGuid,
    randomUUID(),
    ssoSensitiveValues.mailboxCapability,
    ssoSensitiveValues.token,
    ssoAuditTestId().toUpperCase(),
    null,
  ],
}

describe('SSO audit catalogue', () => {
  it('names every group the design lists with one-dot SSO actions', () => {
    expect(actions.sort()).toEqual(
      [
        // Provider create, edit, test, enable, disable and delete; secret and certificate rotation.
        'sso_provider.created',
        'sso_provider.updated',
        'sso_provider.tested',
        'sso_provider.enabled',
        'sso_provider.disabled',
        'sso_provider.deleted',
        'sso_provider.secret_rotated',
        'sso_provider.certificate_rotated',
        // Domain challenge, verification, renewal, expiry and release.
        'sso_domain.challenged',
        'sso_domain.verified',
        'sso_domain.renewed',
        'sso_domain.expired',
        'sso_domain.released',
        // Link, unlink and conflict.
        'sso_link.linked',
        'sso_link.unlinked',
        'sso_link.conflicted',
        // SSO success, failure and rejected replay.
        'sso_authentication.succeeded',
        'sso_authentication.failed',
        'sso_authentication.replay_rejected',
        // JIT admission and refusal.
        'sso_jit.admitted',
        'sso_jit.refused',
        // Enforcement and delegated binding changes.
        'sso_enforcement.enabled',
        'sso_enforcement.disabled',
        'sso_enforcement.updated',
        'sso_delegation.bound',
        'sso_delegation.revoked',
        // Proof revocation.
        'sso_proof.revoked',
        // Recovery enrollment and use.
        'sso_recovery.nominated',
        'sso_recovery.enrolled',
        'sso_recovery.used',
        // Operator maintenance commands.
        'sso_maintenance.enforcement_disabled',
        'sso_maintenance.domain_retired',
        'sso_maintenance.key_rotated',
        // Member and SCIM suspension and reinstatement.
        'sso_member.suspended',
        'sso_member.reinstated',
        'sso_member.scim_suspended',
        'sso_member.scim_reinstated',
      ].sort(),
    )
    for (const action of actions) expect(action).toMatch(/^sso_[a-z_]+\.[a-z_]+$/)
    expect(SSO_SECURITY_FAILURE_ACTIONS).toEqual([
      'sso_authentication.failed',
      'sso_authentication.replay_rejected',
      'sso_jit.refused',
      'sso_link.conflicted',
    ])
  })

  it('keeps the SSO actions apart from the existing catalogue', () => {
    const existing = Object.keys(auditDetails)
    expect(existing.filter((action) => action.startsWith('sso'))).toEqual([])
    expect(actions.filter((action) => existing.includes(action))).toEqual([])
  })

  it('allows only the design detail kinds, with reason codes that are plain names', () => {
    for (const action of actions) {
      for (const key of keysOf(action))
        expect([
          'method',
          'providerId',
          'revision',
          'outcome',
          'reason',
          'correlationId',
        ]).toContain(key)
      expect(new Set(keysOf(action)).size).toBe(keysOf(action).length)
      expect(keysOf(action).includes('outcome')).toBe(spec(action).outcomes !== undefined)
    }
    for (const reason of SSO_AUDIT_REASONS) expect(reason).toMatch(/^[a-z]+(?:_[a-z]+)*$/)
  })

  it('documents every SSO action with its details and the reason codes', () => {
    const doc = readFileSync(new URL('../../../docs/audit-log.md', import.meta.url), 'utf8')
    const section = doc.split('\n## SSO actions\n')[1]?.split('\n## ')[0] ?? ''
    const ticks = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1])
    const documented: Record<string, unknown> = {}
    for (const line of section.split('\n').filter((line) => line.startsWith('| `'))) {
      const cells = line.split('|').slice(1, -1)
      expect(cells, line).toHaveLength(4)
      const [names, required, optional, outcomes] = cells.map((cell) => ticks(cell))
      for (const name of names ?? []) {
        expect(documented, name).not.toHaveProperty([name as string])
        documented[name as string] = {
          required: required ?? [],
          optional: optional ?? [],
          ...(outcomes?.length ? { outcomes } : {}),
        }
      }
    }
    expect(documented).toEqual(
      Object.fromEntries(
        actions.map((action) => [
          action,
          {
            required: [...spec(action).required],
            optional: [...spec(action).optional],
            ...(spec(action).outcomes ? { outcomes: [...(spec(action).outcomes ?? [])] } : {}),
          },
        ]),
      ),
    )
    const reasons = section.split('Reason codes: ')[1]?.split('\n\n')[0] ?? ''
    expect(ticks(reasons)).toEqual([...SSO_AUDIT_REASONS])
    const bound = `At most ${SSO_AUDIT_LIMITS.ssoSecurityFailureEvents} failures are recorded per provider and source (the failure action) in any ${SSO_AUDIT_LIMITS.ssoSecurityFailureWindow.toLocaleString('en-US')}\nseconds`
    expect(section).toContain(bound)
  })

  it('pins the security-failure bound', () => {
    expect(SSO_AUDIT_LIMITS).toEqual({
      ssoSecurityFailureEvents: 20,
      ssoSecurityFailureWindow: 3600,
    })
  })
})

describe.skipIf(!serverUrl)('SSO audit writers', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  const actor = (): Pick<AuditEvent, 'actor' | 'credential'> => ({
    actor: { type: 'user', id: randomUUID() },
    credential: { type: 'session', id: randomUUID() },
  })
  const event = <A extends SsoChangeAction>(
    action: A,
    details: Record<string, unknown>,
    organizationId: string = randomUUID(),
  ) =>
    ({
      organizationId,
      ...actor(),
      action,
      targetType: 'sso_test',
      targetId: randomUUID(),
      details,
    }) as unknown as SsoAuditEvent<A>
  const write = <A extends SsoChangeAction>(value: SsoAuditEvent<A>) =>
    db.transaction().execute((trx) => writeSsoAuditEvent(trx, value))
  const rawInsert = (action: string, details: unknown) =>
    owned.pool.query(
      `INSERT INTO audit_events (actor_type, actor_id, credential_type, action, target_type, target_id, details)
       VALUES ('system', 'test', 'none', $1, 'test', $2, $3::jsonb)`,
      [action, randomUUID(), JSON.stringify(details)],
    )
  const rowsFor = async (organizationId: string) =>
    (
      await owned.pool.query(
        'SELECT action, target_type, target_id, details, actor_type, credential_type, request_id FROM audit_events WHERE organization_id = $1 ORDER BY id',
        [organizationId],
      )
    ).rows
  /** Refused by the application before any SQL: an Error without a SQLSTATE, and no row. */
  const refusedByApplication = async (promise: Promise<unknown>, message: string) => {
    const error = await promise.then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error, message).toBeInstanceOf(Error)
    expect((error as { code?: unknown }).code, message).toBeUndefined()
    return error as Error
  }

  it('records each SSO change with exactly its allow-listed details', async () => {
    for (const action of changeActions)
      for (const full of [true, false]) {
        const organizationId = randomUUID()
        const details = detailsFor(action, full)
        await write(event(action, details, organizationId))
        const [row] = await rowsFor(organizationId)
        expect(row, action).toMatchObject({ action, target_type: 'sso_test', details })
        expect(Object.keys(row.details).sort()).toEqual(Object.keys(details).sort())
      }
  })

  it('refuses extra keys in the application and in the database for every SSO action', async () => {
    const probes = [
      'email',
      'name',
      'secret',
      'clientSecret',
      'token',
      'idToken',
      'assertion',
      'subject',
      'sub',
      'nameId',
      'mailbox',
      'mailboxToken',
      'error',
      'description',
      'method',
      'providerId',
      'revision',
      'outcome',
      'reason',
      'correlationId',
    ]
    for (const action of actions)
      for (const key of probes) {
        if ((keysOf(action) as string[]).includes(key)) continue
        const details = {
          ...detailsFor(action, true),
          [key]: valuesFor(action)[key as SsoAuditDetailKey] ?? 'x',
        }
        if (!(SSO_SECURITY_FAILURE_ACTIONS as readonly string[]).includes(action)) {
          const organizationId = randomUUID()
          const error = await refusedByApplication(
            write(event(action as SsoChangeAction, details, organizationId)),
            `${action} ${key}`,
          )
          expect(error.message).toBe('Audit details are not allow-listed for this action')
          expect(await rowsFor(organizationId)).toEqual([])
        }
        await expect(rawInsert(action, details), `${action} ${key}`).rejects.toMatchObject({
          code: '23514',
          constraint: 'audit_events_details_check',
        })
      }
  }, 120_000)

  it('refuses missing keys and unsafe values in the application and in the database', async () => {
    for (const action of actions) {
      const failure = (SSO_SECURITY_FAILURE_ACTIONS as readonly string[]).includes(action)
      const cases: [string, Record<string, unknown>][] = []
      for (const key of spec(action).required) {
        const { [key]: _, ...rest } = detailsFor(action, true)
        cases.push([`without ${key}`, rest])
      }
      for (const key of keysOf(action))
        for (const value of unsafe[key])
          cases.push([
            `${key} ${JSON.stringify(value)}`,
            { ...detailsFor(action, true), [key]: value },
          ])
      for (const [label, details] of cases) {
        if (!failure) {
          const organizationId = randomUUID()
          await refusedByApplication(
            write(event(action as SsoChangeAction, details, organizationId)),
            `${action} ${label}`,
          )
          expect(await rowsFor(organizationId)).toEqual([])
        }
        await expect(rawInsert(action, details), `${action} ${label}`).rejects.toMatchObject({
          code: '23514',
          constraint: 'audit_events_details_check',
        })
      }
    }
  }, 120_000)

  it('never records a secret, token, assertion, raw subject or mailbox capability', async () => {
    const organizationId = randomUUID()
    const providerId = ssoAuditTestId()
    // As a key's value or as an extra key, through the change writer: refused before SQL.
    for (const value of sensitive) {
      for (const action of changeActions) {
        for (const key of keysOf(action))
          await refusedByApplication(
            write(event(action, { ...detailsFor(action, true), [key]: value }, organizationId)),
            `${action} ${key}`,
          )
        await refusedByApplication(
          write(event(action, { ...detailsFor(action, true), leaked: value }, organizationId)),
          `${action} leaked`,
        )
      }
      // And in the database, whatever the application did.
      for (const key of ['reason', 'correlationId', 'providerId', 'outcome', 'method'])
        await expect(
          rawInsert('sso_provider.tested', {
            ...detailsFor('sso_provider.tested', true),
            [key]: value,
          }),
        ).rejects.toMatchObject({ code: '23514' })
    }
    // Through the failure writer, the request-derived fields are redacted instead.
    for (const value of sensitive)
      for (const action of SSO_SECURITY_FAILURE_ACTIONS)
        await writeSsoSecurityFailure(db, {
          organizationId,
          actor: { type: 'anonymous' },
          credential: { type: 'none' },
          action,
          method: 'oidc',
          providerId,
          revision: value as unknown as number,
          reason: value,
          correlationId: value,
        })
    const rows = await rowsFor(organizationId)
    expect(rows).toHaveLength(sensitive.length * SSO_SECURITY_FAILURE_ACTIONS.length)
    for (const row of rows)
      expect(row.details).toEqual(
        ['sso_authentication.failed', 'sso_jit.refused'].includes(row.action)
          ? { method: 'oidc', providerId, reason: 'unclassified' }
          : { method: 'oidc', providerId },
      )
    const journal = (
      await owned.pool.query<{ text: string }>(
        'SELECT to_jsonb(a)::text AS text FROM audit_events a',
      )
    ).rows.map((row) => row.text)
    for (const value of sensitive)
      expect(journal.filter((text) => text.includes(JSON.stringify(value).slice(1, -1)))).toEqual(
        [],
      )
  }, 120_000)

  it('commits or rolls back an SSO event together with its change', async () => {
    const change = (id: string) =>
      ({ id, name: 'sso audit', slug: id, createdAt: new Date() }) as const
    // Rolled back after the event: neither the change nor the event remains.
    const rolledBack = randomUUID()
    await expect(
      db.transaction().execute(async (trx) => {
        await trx.insertInto('auth.organization').values(change(rolledBack)).execute()
        await writeSsoAuditEvent(
          trx,
          event('sso_provider.created', detailsFor('sso_provider.created', true), rolledBack),
        )
        throw new Error('change failed')
      }),
    ).rejects.toThrow('change failed')
    expect(await rowsFor(rolledBack)).toEqual([])
    expect(
      await db.selectFrom('auth.organization').select('id').where('id', '=', rolledBack).execute(),
    ).toEqual([])
    // An event the application or the database refuses aborts the change.
    for (const details of [
      { ...detailsFor('sso_provider.created', true), reason: 'unclassified' },
      { ...detailsFor('sso_provider.created', true), providerId: randomUUID() },
    ]) {
      const refused = randomUUID()
      await expect(
        db.transaction().execute(async (trx) => {
          await trx.insertInto('auth.organization').values(change(refused)).execute()
          await writeSsoAuditEvent(trx, event('sso_provider.created', details, refused))
        }),
      ).rejects.toThrow()
      expect(
        await db.selectFrom('auth.organization').select('id').where('id', '=', refused).execute(),
      ).toEqual([])
    }
    // Committed: both remain, the event with the request ID of its context.
    const committed = randomUUID()
    await withAuditRequest('sso-request', () =>
      db.transaction().execute(async (trx) => {
        await trx.insertInto('auth.organization').values(change(committed)).execute()
        await writeSsoAuditEvent(trx, event('sso_enforcement.enabled', { revision: 2 }, committed))
        // Typed as a later step will call it: each action takes its own details.
        const providerId = ssoAuditTestId()
        await writeSsoAuditEvent(trx, {
          organizationId: committed,
          ...actor(),
          action: 'sso_provider.tested',
          targetType: 'sso_provider',
          targetId: providerId,
          details: {
            method: 'oidc',
            providerId,
            revision: 3,
            outcome: 'failed',
            reason: 'nonce_mismatch',
          },
        })
        const typed: Omit<SsoAuditEvent<'sso_enforcement.disabled'>, 'details'> = {
          organizationId: committed,
          ...actor(),
          action: 'sso_enforcement.disabled',
          targetType: 'organization',
          targetId: committed,
        }
        const extra: SsoAuditEvent<'sso_enforcement.disabled'> = {
          ...typed,
          // @ts-expect-error A key the action does not take is a type error as well.
          details: { revision: 1, providerId },
        }
        const unlisted: SsoAuditEvent<'sso_provider.tested'> = {
          ...typed,
          action: 'sso_provider.tested',
          details: {
            method: 'oidc',
            providerId,
            revision: 1,
            outcome: 'failed',
            // @ts-expect-error So is a reason code that is not listed.
            reason: 'whatever',
          },
        }
        expect([extra.action, unlisted.action]).toEqual([
          'sso_enforcement.disabled',
          'sso_provider.tested',
        ])
      }),
    )
    expect(await rowsFor(committed)).toMatchObject([
      { action: 'sso_enforcement.enabled', details: { revision: 2 }, request_id: 'sso-request' },
      {
        action: 'sso_provider.tested',
        details: { method: 'oidc', revision: 3, outcome: 'failed', reason: 'nonce_mismatch' },
        request_id: 'sso-request',
      },
    ])
    // The target is a stored ID, never a subject, an address or a token.
    for (const targetId of [
      ssoSensitiveValues.subjectText,
      ssoSensitiveValues.mailbox,
      ssoSensitiveValues.token,
      ssoSensitiveValues.mailboxCapability,
      randomUUID().toUpperCase(),
      '',
    ]) {
      const refused = randomUUID()
      await expect(
        db.transaction().execute(async (trx) => {
          await trx.insertInto('auth.organization').values(change(refused)).execute()
          await writeSsoAuditEvent(trx, {
            ...event('sso_domain.verified', {}, refused),
            targetId,
          })
        }),
      ).rejects.toThrow('SSO audit targets and actors are stored IDs')
      expect(await rowsFor(refused)).toEqual([])
    }
    // So are the target type and the actor: a type name, and a stored ID or service name.
    for (const bad of [
      { targetType: 'SSO provider' },
      { targetType: ssoSensitiveValues.mailbox },
      { actor: { type: 'user', id: ssoSensitiveValues.subjectText } },
      { actor: { type: 'user', id: ssoSensitiveValues.mailbox } },
      { actor: { type: 'api_key', id: ssoSensitiveValues.secret } },
      { actor: { type: 'system', id: 'SSO Maintenance <ops@example.com>' } },
    ]) {
      const refused = randomUUID()
      await expect(
        db.transaction().execute(async (trx) => {
          await trx.insertInto('auth.organization').values(change(refused)).execute()
          await writeSsoAuditEvent(trx, {
            ...event('sso_domain.verified', {}, refused),
            ...bad,
          } as SsoAuditEvent<'sso_domain.verified'>)
        }),
        JSON.stringify(bad),
      ).rejects.toThrow('SSO audit targets and actors are stored IDs')
      expect(await rowsFor(refused)).toEqual([])
    }
    const maintenance = randomUUID()
    await db.transaction().execute((trx) =>
      writeSsoAuditEvent(trx, {
        ...event('sso_maintenance.domain_retired', {}, maintenance),
        actor: { type: 'system', id: 'sso-maintenance' },
        credential: { type: 'none' },
      }),
    )
    expect(await rowsFor(maintenance)).toMatchObject([{ actor_type: 'system' }])
    // Without a transaction there is no change to join: refused, and nothing is written.
    const outside = randomUUID()
    await refusedByApplication(
      writeSsoAuditEvent(db, event('sso_domain.verified', {}, outside)),
      'outside a transaction',
    )
    expect(await rowsFor(outside)).toEqual([])
  })

  it('keeps each writer to its own actions', async () => {
    const organizationId = randomUUID()
    const providerId = ssoAuditTestId()
    const failure: SsoSecurityFailure = {
      organizationId,
      actor: { type: 'anonymous' },
      credential: { type: 'none' },
      action: 'sso_authentication.failed',
      method: 'saml',
      providerId,
      reason: 'signature_invalid',
    }
    // A failure is not a change: it never joins a business transaction.
    for (const action of SSO_SECURITY_FAILURE_ACTIONS)
      await refusedByApplication(
        write(
          event(
            action as unknown as SsoChangeAction,
            { method: 'oidc', providerId },
            organizationId,
          ),
        ),
        action,
      )
    expect(
      (
        await refusedByApplication(
          db.transaction().execute((trx) => writeSsoSecurityFailure(trx, failure)),
          'failure inside a transaction',
        )
      ).message,
    ).toBe('SSO security failures are written in a transaction of their own')
    // A change is not a failure: it is never written outside its change's transaction.
    for (const action of changeActions)
      await refusedByApplication(
        writeSsoSecurityFailure(db, {
          ...failure,
          action: action as unknown as SsoSecurityFailure['action'],
        }),
        action,
      )
    // The generic writer takes no SSO action, and the SSO writer no other action.
    for (const action of actions)
      await expect(
        db.transaction().execute((trx) =>
          writeAuditEvent(trx, {
            ...event('sso_domain.verified', {}, organizationId),
            action: action as unknown as AuditEvent['action'],
            details: {},
          }),
        ),
      ).rejects.toThrow('allow-listed')
    await refusedByApplication(
      write(event('booking.created' as unknown as SsoChangeAction, {}, organizationId)),
      'booking.created',
    )
    // Fields beyond the failure's own, invalid server-side identifiers and a missing team.
    for (const bad of [
      { subject: ssoSensitiveValues.subjectText },
      { details: { reason: 'unclassified' } },
      { email: ssoSensitiveValues.mailbox },
      { providerId: ssoSensitiveValues.subjectGuid },
      { providerId: randomUUID() },
      { method: 'ldap' },
      { organizationId: null },
      // The team in canonical form only, so one team has one lock scope.
      { organizationId: organizationId.replaceAll('-', '') },
      { organizationId: `{${organizationId}}` },
      // Who failed: anonymous, an external user or a signed-in user, by stored ID.
      { actor: { type: 'user', id: ssoSensitiveValues.subjectText } },
      { actor: { type: 'user', id: ssoSensitiveValues.subjectGuid.toUpperCase() } },
      { actor: { type: 'api_key', id: randomUUID() } },
      { actor: { type: 'system', id: 'sso' } },
      { credential: { type: 'session', id: randomUUID() } },
      {
        actor: { type: 'user', id: randomUUID() },
        credential: { type: 'session', id: ssoSensitiveValues.token },
      },
      { credential: { type: 'api_key', id: randomUUID(), scope: 'full' } },
    ])
      await refusedByApplication(
        writeSsoSecurityFailure(db, { ...failure, ...bad } as unknown as SsoSecurityFailure),
        JSON.stringify(bad),
      )
    expect(await rowsFor(organizationId)).toEqual([])
  })

  it('writes a redacted failure in its own transaction', async () => {
    const organizationId = randomUUID()
    const providerId = ssoAuditTestId()
    const correlationId = ssoAuditTestId()
    const base = {
      organizationId,
      actor: { type: 'user' as const, id: randomUUID() },
      credential: { type: 'session' as const, id: randomUUID() },
      method: 'oidc' as const,
      providerId,
    }
    // The request's transaction rolls back; the failure, written once it settled, stays.
    await withAuditRequest('failed-request', async () => {
      await expect(
        db.transaction().execute(async (trx) => {
          await trx
            .insertInto('auth.organization')
            .values({
              id: organizationId,
              name: 'sso',
              slug: organizationId,
              createdAt: new Date(),
            })
            .execute()
          throw new Error('nonce mismatch')
        }),
      ).rejects.toThrow('nonce mismatch')
      await expect(
        writeSsoSecurityFailure(db, {
          ...base,
          action: 'sso_authentication.failed',
          reason: 'nonce_mismatch',
          revision: 4,
          correlationId,
        }),
      ).resolves.toBe(true)
    })
    expect(
      await db
        .selectFrom('auth.organization')
        .select('id')
        .where('id', '=', organizationId)
        .execute(),
    ).toEqual([])
    for (const failure of [
      // Listed codes are kept; anything else is redacted.
      { action: 'sso_jit.refused', reason: 'jit_disabled', revision: 2_147_483_647 },
      { action: 'sso_jit.refused', reason: 'provider said: user is blocked', revision: 0 },
      { action: 'sso_jit.refused' },
      { action: 'sso_authentication.failed', reason: new Error('invalid_grant') },
      // A reason where the action takes none is left out, as is a correlation ID that is not
      // an attempt ID.
      { action: 'sso_authentication.replay_rejected', reason: 'attempt_invalid', correlationId },
      { action: 'sso_link.conflicted', correlationId: randomUUID(), revision: '3' },
    ] as const)
      await expect(
        writeSsoSecurityFailure(db, { ...base, ...failure } as unknown as SsoSecurityFailure),
      ).resolves.toBe(true)
    expect(await rowsFor(organizationId)).toEqual(
      [
        [
          'sso_authentication.failed',
          { reason: 'nonce_mismatch', revision: 4, correlationId },
          'failed-request',
        ],
        ['sso_jit.refused', { reason: 'jit_disabled', revision: 2_147_483_647 }, null],
        ['sso_jit.refused', { reason: 'unclassified' }, null],
        ['sso_jit.refused', { reason: 'unclassified' }, null],
        ['sso_authentication.failed', { reason: 'unclassified' }, null],
        ['sso_authentication.replay_rejected', { correlationId }, null],
        ['sso_link.conflicted', {}, null],
      ].map(([action, details, requestId]) => ({
        action,
        target_type: 'sso_provider',
        target_id: providerId,
        details: { method: 'oidc', providerId, ...(details as object) },
        actor_type: 'user',
        credential_type: 'session',
        request_id: requestId,
      })),
    )
  })

  it('bounds failure events per provider and source under a burst', async () => {
    const organizationId = randomUUID()
    const providers = [ssoAuditTestId(), ssoAuditTestId()]
    const limit = SSO_AUDIT_LIMITS.ssoSecurityFailureEvents
    const failure = (providerId: string, action: SsoSecurityFailure['action']) => ({
      organizationId,
      actor: { type: 'anonymous' as const },
      credential: { type: 'none' as const },
      action,
      method: 'saml' as const,
      providerId,
      reason: 'signature_invalid',
    })
    const scopes = [
      failure(providers[0] as string, 'sso_authentication.failed'),
      failure(providers[0] as string, 'sso_authentication.replay_rejected'),
      failure(providers[1] as string, 'sso_authentication.failed'),
    ]
    // Three times the bound per scope, all at once, interleaved across scopes; every other call
    // spells the team's ID in upper case, which is still the same team.
    const results = await Promise.all(
      Array.from({ length: limit * 3 }, () => scopes).flatMap((group, index) =>
        group.map((value) =>
          writeSsoSecurityFailure(
            db,
            index % 2 ? { ...value, organizationId: organizationId.toUpperCase() } : value,
          ),
        ),
      ),
    )
    expect(results.filter(Boolean)).toHaveLength(limit * scopes.length)
    const counts = (
      await owned.pool.query<{ target_id: string; action: string; n: number }>(
        `SELECT target_id, action, count(*)::int AS n FROM audit_events
         WHERE organization_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`,
        [organizationId],
      )
    ).rows
    expect(counts).toEqual(
      scopes
        .map((scope) => ({ target_id: scope.providerId, action: scope.action, n: limit }))
        .sort((a, b) => `${a.target_id}${a.action}`.localeCompare(`${b.target_id}${b.action}`)),
    )
    // Another team's provider has its own bound.
    await expect(
      writeSsoSecurityFailure(db, {
        ...scopes[0],
        organizationId: randomUUID(),
      } as SsoSecurityFailure),
    ).resolves.toBe(true)
    expect(owned.pool.totalCount).toBeLessThanOrEqual(10)
  }, 60_000)

  it('counts the failures of a concurrent writer before admitting another', async () => {
    // Also where sessions default to repeatable read, whose snapshot would predate the lock.
    const repeatable = new pg.Pool({
      connectionString: owned.url,
      max: 2,
      options: '-c default_transaction_isolation=repeatable\\ read',
    })
    try {
      for (const handle of [db, createDb(repeatable)]) {
        const organizationId = randomUUID()
        const failure: SsoSecurityFailure = {
          organizationId,
          actor: { type: 'anonymous' },
          credential: { type: 'none' },
          action: 'sso_link.conflicted',
          method: 'oidc',
          providerId: ssoAuditTestId(),
        }
        const limit = SSO_AUDIT_LIMITS.ssoSecurityFailureEvents
        for (let index = 1; index < limit; index++)
          await expect(writeSsoSecurityFailure(handle, failure)).resolves.toBe(true)
        // Another writer holds the scope and has written the last admitted event, uncommitted.
        const other = await owned.pool.connect()
        try {
          await other.query('BEGIN')
          await other.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
            ssoSecurityFailureScope(failure),
          ])
          await other.query(
            `INSERT INTO audit_events (organization_id, actor_type, credential_type, action, target_type, target_id, details)
             VALUES ($1, 'anonymous', 'none', $2, 'sso_provider', $3, $4::jsonb)`,
            [
              organizationId,
              failure.action,
              failure.providerId,
              JSON.stringify({ method: 'oidc', providerId: failure.providerId }),
            ],
          )
          let settled = false
          const pending = writeSsoSecurityFailure(handle, failure).finally(() => {
            settled = true
          })
          await setTimeout(300)
          expect(settled).toBe(false)
          await other.query('COMMIT')
          await expect(pending).resolves.toBe(false)
        } finally {
          // Never hand a client with an open transaction back to the pool.
          other.release(true)
        }
        expect(await rowsFor(organizationId)).toHaveLength(limit)
      }
    } finally {
      await repeatable.end()
    }
  })

  it('validates and writes the same details, read once', async () => {
    const organizationId = randomUUID()
    let reads = 0
    const details = {
      method: 'oidc',
      providerId: ssoAuditTestId(),
      revision: 1,
      outcome: 'failed',
      get reason() {
        reads++
        return reads === 1 ? 'signature_invalid' : ssoSensitiveValues.token
      },
    }
    await write(event('sso_provider.tested', details, organizationId))
    expect(reads).toBe(1)
    expect(await rowsFor(organizationId)).toMatchObject([
      { details: { reason: 'signature_invalid' } },
    ])
  })

  it('drops a failure past the bound without waiting for the lock', async () => {
    const failure: SsoSecurityFailure = {
      organizationId: randomUUID(),
      actor: { type: 'anonymous' },
      credential: { type: 'none' },
      action: 'sso_jit.refused',
      method: 'saml',
      providerId: ssoAuditTestId(),
      reason: 'jit_disabled',
    }
    for (let index = 0; index < SSO_AUDIT_LIMITS.ssoSecurityFailureEvents; index++)
      await expect(writeSsoSecurityFailure(db, failure)).resolves.toBe(true)
    const other = await owned.pool.connect()
    let dropped: Promise<unknown> | undefined
    try {
      await other.query('BEGIN')
      await other.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        ssoSecurityFailureScope(failure),
      ])
      // A flood past the bound holds no transaction and no lock while it is dropped.
      dropped = Promise.all(Array.from({ length: 30 }, () => writeSsoSecurityFailure(db, failure)))
      const outcome = await Promise.race([dropped, setTimeout(2_000, 'waiting')])
      expect(outcome).toEqual(Array.from({ length: 30 }, () => false))
      await other.query('COMMIT')
    } finally {
      // Ending the session releases the lock, so writers that did wait finish before teardown.
      other.release(true)
      await dropped?.catch(() => undefined)
    }
    expect(await rowsFor(failure.organizationId)).toHaveLength(
      SSO_AUDIT_LIMITS.ssoSecurityFailureEvents,
    )
  })

  it('lets the window slide', async () => {
    const organizationId = randomUUID()
    const failure: SsoSecurityFailure = {
      organizationId,
      actor: { type: 'anonymous' },
      credential: { type: 'none' },
      action: 'sso_authentication.replay_rejected',
      method: 'saml',
      providerId: ssoAuditTestId(),
    }
    const { ssoSecurityFailureEvents: limit, ssoSecurityFailureWindow: window } = SSO_AUDIT_LIMITS
    for (let index = 0; index < limit; index++)
      await expect(writeSsoSecurityFailure(db, failure)).resolves.toBe(true)
    await expect(writeSsoSecurityFailure(db, failure)).resolves.toBe(false)
    // Still inside the window a little before its end: nothing more is admitted.
    const age = (seconds: number) =>
      owned.pool.query(
        `UPDATE audit_events SET occurred_at = clock_timestamp() - $2 * interval '1 second'
         WHERE organization_id = $1`,
        [organizationId, seconds],
      )
    await age(window - 30)
    await expect(writeSsoSecurityFailure(db, failure)).resolves.toBe(false)
    // Past it, the provider and source start again.
    await age(window + 1)
    await expect(writeSsoSecurityFailure(db, failure)).resolves.toBe(true)
    expect(await rowsFor(organizationId)).toHaveLength(limit + 1)
  })
})
