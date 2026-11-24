import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
    expect(
      statement.sql,
    ).toBe(`select (${production.slice('select '.length, -' as "suspended"'.length)} OR EXISTS (
    SELECT 1 FROM scim_team_managed_memberships AS managed_source
    WHERE managed_source.child_organization_id = $4::uuid
      AND managed_source.user_id = $5::uuid AND managed_source.suspended_at IS NOT NULL
  )) as "suspended"`)
  })

  it('is given the capability decision by every caller', () => {
    // A caller that leaves the third argument out would silently keep a directory-suspended
    // child member active on its path once the capability is on.
    const root = join(import.meta.dirname, '../../..')
    const sources = ['apps', 'packages'].flatMap((workspace) =>
      readdirSync(join(root, workspace), { recursive: true, encoding: 'utf8' })
        .filter(
          (file) =>
            /(^|\/)src\//.test(file) &&
            file.endsWith('.ts') &&
            !file.endsWith('.test.ts') &&
            !file.includes('node_modules') &&
            !file.endsWith('db/src/scim-suspension.ts'),
        )
        .map((file) => join(workspace, file)),
    )
    const calls: { file: string; arguments: number }[] = []
    for (const file of sources) {
      const source = readFileSync(join(root, file), 'utf8')
      for (const match of source.matchAll(/\bscimSuspended\(/g)) {
        let depth = 1
        let count = 1
        let text = ''
        for (let index = match.index + match[0].length; depth > 0; index++) {
          const character = source[index] as string
          if ('([{'.includes(character)) depth++
          else if (')]}'.includes(character)) depth--
          else if (character === ',' && depth === 1) {
            if (
              source
                .slice(index + 1)
                .trimStart()
                .startsWith(')')
            )
              continue
            count++
          }
          text += character
        }
        expect(text.trim(), file).not.toBe(')')
        calls.push({ file, arguments: count })
      }
    }
    expect(calls.length).toBeGreaterThanOrEqual(25)
    expect(calls.filter((call) => call.arguments !== 3)).toEqual([])
  })
})
