import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@babel/parser'
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
const compiled = (capability: boolean) =>
  db.selectNoFrom(scimSuspended(organization, user, capability).as('suspended')).compile()

function scanSuspensionCalls(source: string) {
  const calls: { line: number; hasDecision: boolean }[] = []
  function visit(value: unknown): void {
    if (value === null || typeof value !== 'object') return
    const node = value as {
      type?: string
      callee?: { type: string; name?: string }
      arguments?: { type: string; name?: string; value?: unknown }[]
      loc?: { start: { line: number } }
    }
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      node.callee.name === 'scimSuspended'
    ) {
      const decision = node.arguments?.[2]
      calls.push({
        line: node.loc?.start.line ?? 0,
        hasDecision:
          node.arguments?.length === 3 &&
          decision?.type !== 'SpreadElement' &&
          !(decision?.type === 'BooleanLiteral' && decision.value === false) &&
          !(decision?.type === 'Identifier' && decision.name === 'undefined'),
      })
    }
    for (const child of Object.values(value)) visit(child)
  }
  visit(parse(source, { sourceType: 'module', plugins: ['typescript'] }).program)
  return calls
}

const primarySuspension = `CASE WHEN EXISTS (
    SELECT 1 FROM scim_membership_blocks AS block
    WHERE block.organization_id = $1::uuid AND block.user_id = $2::uuid
      AND block.source = 'scim' AND block.kind = 'suspension' AND block.cleared_at IS NULL
  ) THEN NOT EXISTS (
    SELECT 1 FROM personal_organizations AS personal
    WHERE personal.organization_id = $3::uuid
  ) ELSE false END`

describe('SCIM suspension statement', () => {
  it('preserves existing suspensions with the resource capability disabled', () => {
    expect(compiled(false)).toEqual(compiled(true))
  })

  it('reads parent and child suspensions by organization and account', () => {
    const statement = compiled(true)
    expect(statement.parameters).toEqual([organization, user, organization, organization, user])
    expect(statement.sql).toBe(`select (${primarySuspension} OR EXISTS (
    SELECT 1 FROM scim_team_managed_memberships AS managed_source
    WHERE managed_source.child_organization_id = $4::uuid
      AND managed_source.user_id = $5::uuid AND managed_source.suspended_at IS NOT NULL
  )) as "suspended"`)
  })

  it('is given the capability decision by every caller', () => {
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
    const calls = sources.flatMap((file) => {
      const source = readFileSync(join(root, file), 'utf8')
      if (!source.includes('scimSuspended')) return []
      return scanSuspensionCalls(source).map((call) => ({ file, ...call }))
    })
    expect(calls.length).toBeGreaterThanOrEqual(25)
    expect(calls.filter((call) => !call.hasDecision)).toEqual([])
  })

  it('ignores comments and strings and detects omitted or hard-coded off decisions', () => {
    const source = [
      '// scimSuspended(([',
      'const example = "scimSuspended({";',
      'scimSuspended(org, user);',
      'scimSuspended(org, user, false);',
      'scimSuspended(org, user, undefined);',
      'scimSuspended(ref("org"), ref("user"), flags.scimResourcesEnabled === true,);',
    ].join('\n')
    expect(scanSuspensionCalls(source)).toEqual([
      { line: 3, hasDecision: false },
      { line: 4, hasDecision: false },
      { line: 5, hasDecision: false },
      { line: 6, hasDecision: true },
    ])
  })
})
