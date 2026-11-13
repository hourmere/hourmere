// Every constraint, index and NOT NULL column of migration 0067 (audit_events), each with
// a check that passes on the schema as migrated and fails when that object is dropped
// (audit-events-coverage.test.ts). The details check, which 0078 redefines, is checked by
// assertAuditDetailProtections.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect } from 'vitest'
import { assertAuditDetailProtections } from './audit-actions-followups-protections.ts'

const columns = [
  'actor_type',
  'actor_id',
  'credential_type',
  'credential_id',
  'credential_scope',
  'oauth_client_id',
  'oauth_grant_id',
  'action',
  'target_type',
  'target_id',
  'details',
  'request_id',
] as const
type Row = Partial<Record<(typeof columns)[number] | 'occurred_at' | 'organization_id', unknown>>
const valid: Row = {
  actor_type: 'user',
  actor_id: 'coverage-user',
  credential_type: 'session',
  credential_id: 'coverage-session',
  action: 'booking.created',
  target_type: 'booking',
  target_id: 'coverage-booking',
  details: '{}',
}

/** Inserts `valid` with these overrides; an `undefined` override omits the column. */
function insert(pool: pg.Pool, overrides: Row) {
  const row = Object.entries({ ...valid, target_id: randomUUID(), ...overrides }).filter(
    ([, value]) => value !== undefined,
  )
  return pool.query(
    `INSERT INTO audit_events (${row.map(([name]) => name).join(', ')}) VALUES (${row.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, occurred_at, details`,
    row.map(([, value]) => value),
  )
}
const refusedBy = (pool: pg.Pool, overrides: Row, constraint: string, code = '23514') =>
  expect(
    insert(pool, overrides),
    `${constraint} ${JSON.stringify(overrides)}`,
  ).rejects.toMatchObject({ code, constraint })
const accepted = (pool: pg.Pool, overrides: Row) =>
  expect(insert(pool, overrides), JSON.stringify(overrides)).resolves.toMatchObject({ rowCount: 1 })

const indexes = {
  audit_events_organization_time:
    'CREATE INDEX audit_events_organization_time ON public.audit_events USING btree (organization_id, occurred_at DESC, id DESC)',
  audit_events_organization_actor:
    'CREATE INDEX audit_events_organization_actor ON public.audit_events USING btree (organization_id, actor_type, actor_id, occurred_at DESC, id DESC)',
  audit_events_organization_action:
    'CREATE INDEX audit_events_organization_action ON public.audit_events USING btree (organization_id, action, occurred_at DESC, id DESC)',
}

/** Throws when any 0067 protection on audit_events is missing. */
export async function assertAuditEventProtections(pool: pg.Pool): Promise<void> {
  // Defaults: the database clock and an empty object.
  const defaults = await insert(pool, { details: undefined })
  expect(defaults.rows[0]?.details).toEqual({})
  expect(defaults.rows[0]?.occurred_at).toBeInstanceOf(Date)
  await accepted(pool, { organization_id: randomUUID(), request_id: 'r'.repeat(128) })

  // Closed actor and credential sets, and the dotted action name.
  await refusedBy(pool, { actor_type: 'robot' }, 'audit_events_actor_type_check')
  // audit_credential_shape is checked first (by name) and admits only the four types.
  await refusedBy(pool, { credential_type: 'cookie' }, 'audit_credential_shape')
  for (const action of ['Booking.created', 'booking', 'booking.created.twice', 'booking.created '])
    await refusedBy(pool, { action }, 'audit_events_action_check')

  // Bounded target and request identifiers.
  for (const target_type of ['', 't'.repeat(81)])
    await refusedBy(pool, { target_type }, 'audit_events_target_type_check')
  await accepted(pool, { target_type: 't'.repeat(80), target_id: 'i'.repeat(256) })
  for (const target_id of ['', 'i'.repeat(257)])
    await refusedBy(pool, { target_id }, 'audit_events_target_id_check')
  for (const request_id of ['', 'r'.repeat(129)])
    await refusedBy(pool, { request_id }, 'audit_events_request_id_check')

  // Actors without IDs are exactly the anonymous and external ones.
  await refusedBy(
    pool,
    { actor_type: 'anonymous', credential_type: 'none', credential_id: null },
    'audit_actor_identity',
  )
  await refusedBy(pool, { actor_id: null }, 'audit_actor_identity')
  await refusedBy(pool, { actor_id: 'a'.repeat(257) }, 'audit_actor_identity')
  await accepted(pool, {
    actor_type: 'external_user',
    actor_id: null,
    credential_type: 'none',
    credential_id: null,
  })
  // External callers never leave credential identifiers.
  await refusedBy(
    pool,
    {
      actor_type: 'external_api_key',
      actor_id: null,
      credential_type: 'session',
      credential_id: null,
    },
    'audit_external_actor_credential',
  )
  // Each credential type carries exactly its own identifiers.
  for (const shape of [
    { credential_type: 'none' },
    { credential_type: 'session', credential_scope: 'full' },
    { credential_type: 'api_key', credential_id: null },
    { credential_type: 'api_key', credential_scope: 'admin' },
    { credential_type: 'api_key', oauth_client_id: 'client' },
    { credential_type: 'oauth', credential_id: null, oauth_client_id: 'client' },
    {
      credential_type: 'oauth',
      credential_id: 'key',
      oauth_client_id: 'client',
      oauth_grant_id: 'grant',
    },
  ])
    await refusedBy(pool, shape, 'audit_credential_shape')
  await accepted(pool, {
    credential_type: 'api_key',
    credential_id: 'key',
    credential_scope: 'bookings',
  })
  await accepted(pool, {
    credential_type: 'oauth',
    credential_id: null,
    oauth_client_id: 'client',
    oauth_grant_id: 'grant',
  })

  // Required columns: every other check on them passes on NULL.
  for (const column of [
    'occurred_at',
    'actor_type',
    'credential_type',
    'action',
    'target_type',
    'target_id',
    'details',
  ] as const)
    await expect(insert(pool, { [column]: null }), column).rejects.toMatchObject({
      code: '23502',
      column,
    })

  // One row per ID.
  const id = (await insert(pool, {})).rows[0]?.id as string
  await expect(
    pool.query(
      `INSERT INTO audit_events (id, actor_type, actor_id, credential_type, action, target_type, target_id)
       OVERRIDING SYSTEM VALUE VALUES ($1, 'system', 'coverage', 'none', 'booking.created', 'booking', 'x')`,
      [id],
    ),
  ).rejects.toMatchObject({ code: '23505', constraint: 'audit_events_pkey' })

  // The read indexes have no other behaviour: pin their definitions.
  const found = await pool.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'audit_events'
       AND indexname = ANY($1) ORDER BY indexname`,
    [Object.keys(indexes)],
  )
  expect(Object.fromEntries(found.rows.map((row) => [row.indexname, row.indexdef]))).toEqual(
    indexes,
  )

  await assertAuditDetailProtections(pool)
}
