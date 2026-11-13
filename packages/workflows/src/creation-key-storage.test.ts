// Binds the credential kinds that migration 0087 (workflow creation keys) accepts to the
// principal kinds of @hourmere/auth. A create's key is scoped by the kind of the principal that
// made it, so a new or renamed principal kind must change the database check in the same
// change: typecheck fails when the list below and `Principal['kind']` differ, and this test
// fails when the check and the list differ.
import type { Principal } from '@hourmere/auth'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest'

const serverUrl = process.env.DATABASE_URL

/** Every principal kind. */
const PRINCIPAL_KINDS = ['session', 'api_key', 'oauth'] as const
/** A session principal's key names no credential record; every other kind names its record. */
const RECORDLESS: readonly Principal['kind'][] = ['session']

/** A list as `pg_get_constraintdef` prints it: one value as `= 'x'::text`, more as `= ANY`. */
const list = (values: readonly string[]) =>
  values.length === 1
    ? `= '${values[0]}'::text`
    : `= ANY (ARRAY[${values.map((value) => `'${value}'::text`).join(', ')}])`

describe('workflow creation key credential kinds', () => {
  it('lists exactly the principal kinds', () => {
    expectTypeOf<(typeof PRINCIPAL_KINDS)[number]>().toEqualTypeOf<Principal['kind']>()
    expect(new Set(PRINCIPAL_KINDS).size).toBe(PRINCIPAL_KINDS.length)
    for (const kind of RECORDLESS) expect(PRINCIPAL_KINDS).toContain(kind)
  })
})

describe.skipIf(!serverUrl)('workflow creation key storage and the principal kinds', () => {
  let owned: TestDatabase

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'wf_key_kinds' })
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('accepts exactly the principal kinds, with a credential record for all but a session', async () => {
    const { rows } = await owned.pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname='workflow_creation_keys_credential'
        AND conrelid='workflow_creation_keys'::regclass`,
    )
    const recorded = PRINCIPAL_KINDS.filter((kind) => !RECORDLESS.includes(kind))
    expect(rows.map(({ definition }) => definition)).toEqual([
      `CHECK ((((credential_kind ${list(RECORDLESS)}) AND (credential_id IS NULL)) OR ((credential_kind ${list(recorded)}) AND (credential_id IS NOT NULL))))`,
    ])
  })
})
