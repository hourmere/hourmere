import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely'
import { describe, expect, it } from 'vitest'
import type { Database } from './index.ts'
import { scimSuspended } from './scim-suspension.ts'

const db = new Kysely<Database>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (instance) => new PostgresIntrospector(instance),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
})
const organization = '00000000-0000-4000-8000-000000000001'
const user = '00000000-0000-4000-8000-000000000002'
const compiled = (...capability: [] | [boolean]) =>
  db.selectNoFrom(scimSuspended(organization, user, ...capability).as('suspended')).compile()

// The statement every production authorization path embeds while SCIM resources are off.
const production = `select CASE WHEN EXISTS (
    SELECT 1 FROM scim_membership_blocks AS block
    WHERE block.organization_id = $1::uuid AND block.user_id = $2::uuid
      AND block.source = 'scim' AND block.kind = 'suspension' AND block.cleared_at IS NULL
  ) THEN NOT EXISTS (
    SELECT 1 FROM personal_organizations AS personal
    WHERE personal.organization_id = $3::uuid
  ) ELSE false END as "suspended"`

describe('SCIM suspension statement', () => {
  it('is unchanged and reads no Group storage without the resource capability', () => {
    for (const statement of [compiled(), compiled(false)]) {
      expect(statement.sql).toBe(production)
      expect(statement.parameters).toEqual([organization, user, organization])
      expect(statement.sql).not.toContain('scim_team_managed_memberships')
    }
  })

  it('also reads a managed membership suspension with the resource capability', () => {
    const statement = compiled(true)
    expect(statement.sql).toContain(production.slice('select '.length, -' as "suspended"'.length))
    expect(statement.sql).toContain('scim_team_managed_memberships')
    expect(statement.sql).toContain('managed_source.suspended_at IS NOT NULL')
    expect(statement.parameters).toEqual([organization, user, organization, organization, user])
  })
})
