import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

const serverUrl = process.env.DATABASE_URL
const mappingTable = 'scim_team_mappings'
const generationTable = 'scim_team_link_generations'
const rolesTable = 'scim_team_link_roles'
const intentsTable = 'scim_team_mapping_intents'
const consentsTable = 'scim_team_mapping_consents'
const rosterTable = 'scim_team_managed_memberships'

function insert(pool: pg.Pool, table: string, values: Record<string, unknown>) {
  return pool.query(
    `INSERT INTO ${table} (${Object.keys(values).join(', ')})
     VALUES (${Object.keys(values)
       .map((_, index) => `$${index + 1}`)
       .join(', ')})`,
    Object.values(values),
  )
}

async function needsColumns(
  pool: pg.Pool,
  table: string,
  values: Record<string, unknown>,
  columns = Object.keys(values),
) {
  for (const column of columns) {
    await expect(
      insert(pool, table, { ...values, [column]: null }),
      `${table}.${column}`,
    ).rejects.toMatchObject({ code: '23502', table, column })
  }
}

async function refuse(query: Promise<pg.QueryResult>, code: string, constraint: string) {
  await expect(query, constraint).rejects.toMatchObject({ code, constraint })
}

async function accept(query: Promise<pg.QueryResult>, rowCount = 1) {
  await expect(query).resolves.toMatchObject({ rowCount })
}

async function seed(pool: pg.Pool) {
  const parent = randomUUID()
  const child = randomUUID()
  const sibling = randomUUID()
  const other = randomUUID()
  const spare = randomUUID()
  const personal = randomUUID()
  const parentConnection = randomUUID()
  const childConnection = randomUUID()
  const otherConnection = randomUUID()
  const personalConnection = randomUUID()
  const owner = randomUUID()
  const member = randomUUID()
  await accept(
    pool.query(
      `INSERT INTO auth.organization (id,name,slug,"createdAt")
       SELECT id, 'Hierarchy fixture', id::text, now() FROM unnest($1::uuid[]) AS ids(id)`,
      [[parent, child, sibling, other, spare, personal]],
    ),
    6,
  )
  await accept(
    pool.query(
      `INSERT INTO scim_connections (id,organization_id)
       VALUES ($1,$2),($3,$4),($5,$6),($7,$8)`,
      [
        parentConnection,
        parent,
        childConnection,
        child,
        otherConnection,
        other,
        personalConnection,
        personal,
      ],
    ),
    4,
  )
  await accept(
    pool.query(
      `INSERT INTO auth."user" (id,name,email,"emailVerified","createdAt","updatedAt")
       VALUES ($1,'Hierarchy fixture','hierarchy@example.test',true,now(),now())`,
      [owner],
    ),
  )
  await accept(
    pool.query(
      `INSERT INTO auth.member (id,"organizationId","userId",role,"createdAt")
       VALUES ($1,$2,$3,'member',now())`,
      [member, child, owner],
    ),
  )
  await accept(
    insert(pool, 'personal_organizations', { user_id: owner, organization_id: personal }),
  )
  return {
    parent,
    child,
    sibling,
    other,
    spare,
    personal,
    parentConnection,
    childConnection,
    otherConnection,
    personalConnection,
    owner,
    member,
  }
}

type Teams = Awaited<ReturnType<typeof seed>>

function endpoints(parent: string, child: string, connection: string) {
  return { parent_organization_id: parent, child_organization_id: child, connection_id: connection }
}

async function assertTopology(pool: pg.Pool, f: Teams) {
  const initialMapping = randomUUID()
  const edge = (parent: string, child: string, connection: string, externalId: string) =>
    insert(pool, mappingTable, { ...endpoints(parent, child, connection), external_id: externalId })
  const first = { ...endpoints(f.parent, f.child, f.parentConnection), external_id: 'Engineering' }
  await needsColumns(pool, mappingTable, { ...first, created_at: new Date() })
  await refuse(
    edge(f.parent, f.parent, f.parentConnection, 'self'),
    '23514',
    'scim_team_mappings_distinct_teams',
  )
  await refuse(
    edge(f.personal, f.child, f.personalConnection, 'personal-parent'),
    '23514',
    'scim_team_mappings_nonpersonal',
  )
  await refuse(
    edge(f.parent, f.personal, f.parentConnection, 'personal-child'),
    '23514',
    'scim_team_mappings_nonpersonal',
  )
  await refuse(
    edge(f.parent, f.child, f.otherConnection, 'wrong-connection'),
    '23503',
    'scim_team_mappings_live_connection_scope',
  )
  await refuse(
    edge(f.parent, randomUUID(), f.parentConnection, 'missing-child'),
    '23503',
    'scim_team_mappings_live_child_fkey',
  )
  await refuse(
    edge(f.parent, f.child, f.parentConnection, ''),
    '23514',
    'scim_team_mappings_external_id_length',
  )
  await refuse(
    insert(pool, mappingTable, { ...first, retired_at: new Date() }),
    '23514',
    'scim_team_mappings_starts_live',
  )
  await expect(
    pool.query(`SELECT generation FROM ${generationTable} WHERE child_organization_id=$1`, [
      f.child,
    ]),
  ).resolves.toMatchObject({ rows: [] })
  await accept(insert(pool, mappingTable, { ...first, id: initialMapping }))
  await expect(
    pool.query(`SELECT generation FROM ${generationTable} WHERE child_organization_id=$1`, [
      f.child,
    ]),
  ).resolves.toMatchObject({ rows: [{ generation: 1 }] })
  await refuse(
    edge(f.child, f.parent, f.childConnection, 'cycle'),
    '23P01',
    'scim_team_link_roles_depth',
  )
  await refuse(
    edge(f.child, f.spare, f.childConnection, 'outgoing-depth'),
    '23P01',
    'scim_team_link_roles_depth',
  )
  await refuse(
    edge(f.other, f.parent, f.otherConnection, 'incoming-depth'),
    '23P01',
    'scim_team_link_roles_depth',
  )
  await refuse(
    edge(f.other, f.child, f.otherConnection, 'second-parent'),
    '23505',
    'scim_team_mappings_one_live_parent',
  )
  await refuse(
    edge(f.parent, f.child, f.parentConnection, 'another-mapping'),
    '23505',
    'scim_team_mappings_one_live_parent',
  )
  await refuse(
    edge(f.parent, f.sibling, f.parentConnection, 'Engineering'),
    '23505',
    'scim_team_mappings_one_live_external_id',
  )
  await accept(edge(f.parent, f.sibling, f.parentConnection, 'engineering'))
  await accept(edge(f.other, f.spare, f.otherConnection, 'Engineering'))
  await refuse(
    pool.query(`UPDATE ${mappingTable} SET external_id='other' WHERE id=$1`, [initialMapping]),
    '23514',
    'scim_team_mappings_identity',
  )
  await refuse(
    pool.query(
      `UPDATE ${mappingTable} SET suspended_at=created_at-interval '1 second' WHERE id=$1`,
      [initialMapping],
    ),
    '23514',
    'scim_team_mappings_lifetime',
  )
  await accept(
    pool.query(`UPDATE ${mappingTable} SET suspended_at=clock_timestamp() WHERE id=$1`, [
      initialMapping,
    ]),
  )
  await refuse(
    edge(f.other, f.child, f.otherConnection, 'suspended-child'),
    '23505',
    'scim_team_mappings_one_live_parent',
  )
  await refuse(
    pool.query('DELETE FROM auth.organization WHERE id=$1', [f.parent]),
    '23503',
    'scim_team_mappings_live_connection_scope',
  )
  await refuse(
    pool.query('DELETE FROM auth.organization WHERE id=$1', [f.child]),
    '23503',
    'scim_team_mappings_live_child_fkey',
  )
  await refuse(
    pool.query(`UPDATE ${mappingTable} SET suspended_at=NULL WHERE id=$1`, [initialMapping]),
    '23514',
    'scim_team_mappings_identity',
  )
  await accept(
    pool.query(`UPDATE ${mappingTable} SET retired_at=clock_timestamp() WHERE id=$1`, [
      initialMapping,
    ]),
  )
  await expect(
    pool.query(`SELECT generation FROM ${generationTable} WHERE child_organization_id=$1`, [
      f.child,
    ]),
  ).resolves.toMatchObject({ rows: [{ generation: 2 }] })
  await refuse(
    pool.query(`UPDATE ${mappingTable} SET retired_at=NULL WHERE id=$1`, [initialMapping]),
    '23514',
    'scim_team_mappings_identity',
  )
  await refuse(
    pool.query(`DELETE FROM ${mappingTable} WHERE id=$1`, [initialMapping]),
    '23514',
    'scim_team_mappings_identity',
  )
  await accept(edge(f.parent, f.child, f.parentConnection, 'Engineering'))
  await expect(
    pool.query(`SELECT generation FROM ${generationTable} WHERE child_organization_id=$1`, [
      f.child,
    ]),
  ).resolves.toMatchObject({ rows: [{ generation: 3 }] })
}

async function assertInternalRows(pool: pg.Pool, f: Teams) {
  const target = { child_organization_id: f.child }
  await refuse(
    insert(pool, generationTable, { ...target, generation: -1 }),
    '23514',
    'scim_team_link_generation_nonnegative',
  )
  await refuse(
    insert(pool, generationTable, { ...target, generation: 2 }),
    '23505',
    'scim_team_link_generations_pkey',
  )
  await refuse(
    insert(pool, generationTable, { child_organization_id: randomUUID() }),
    '23503',
    'scim_team_link_generations_child_organization_id_fkey',
  )
  await expect(
    insert(pool, generationTable, { child_organization_id: f.other, generation: null }),
  ).rejects.toMatchObject({ code: '23502', table: generationTable, column: 'generation' })
  const result = pool.query(
    `SELECT id FROM ${mappingTable} WHERE live_child_organization_id = $1`,
    [f.child],
  )
  await expect(result).resolves.toMatchObject({ rowCount: 1 })
  const mappingId: string = (await result).rows[0].id
  const role = { mapping_id: mappingId, organization_id: randomUUID(), side: 'child' }
  await refuse(insert(pool, rolesTable, role), '23505', 'scim_team_link_roles_pkey')
  await refuse(
    insert(pool, rolesTable, { ...role, mapping_id: randomUUID() }),
    '23503',
    'scim_team_link_roles_mapping_id_fkey',
  )
  await refuse(
    insert(pool, rolesTable, { ...role, side: 'unknown' }),
    '23514',
    'scim_team_link_roles_side',
  )
  await expect(
    pool.query(
      `UPDATE ${rolesTable} SET organization_id=NULL WHERE mapping_id=$1 AND side='parent'`,
      [mappingId],
    ),
  ).rejects.toMatchObject({ code: '23502', table: rolesTable, column: 'organization_id' })
  const membership = {
    mapping_id: mappingId,
    child_organization_id: f.child,
    member_id: f.member,
    user_id: f.owner,
  }
  await needsColumns(pool, rosterTable, membership, [
    'mapping_id',
    'child_organization_id',
    'user_id',
  ])
  await refuse(
    insert(pool, rosterTable, { ...membership, mapping_id: randomUUID() }),
    '23503',
    'scim_team_managed_memberships_mapping_scope',
  )
  await refuse(
    insert(pool, rosterTable, { ...membership, user_id: randomUUID() }),
    '23503',
    'scim_team_managed_memberships_member_scope',
  )
  await accept(insert(pool, rosterTable, membership))
  await refuse(insert(pool, rosterTable, membership), '23505', 'scim_team_managed_memberships_pkey')
  await refuse(
    pool.query(`UPDATE ${mappingTable} SET retired_at=clock_timestamp() WHERE id=$1`, [mappingId]),
    '23503',
    'scim_team_managed_memberships_mapping_scope',
  )
  await accept(pool.query('DELETE FROM auth.member WHERE id=$1', [f.member]))
  await expect(
    pool.query(`SELECT member_id FROM ${rosterTable} WHERE member_id=$1`, [f.member]),
  ).resolves.toMatchObject({ rows: [] })
  await accept(
    pool.query(`UPDATE ${mappingTable} SET retired_at=clock_timestamp() WHERE id=$1`, [mappingId]),
  )
  await accept(pool.query('DELETE FROM auth.organization WHERE id=$1', [f.child]))
  await expect(
    pool.query(`SELECT generation FROM ${generationTable} WHERE child_organization_id=$1`, [
      f.child,
    ]),
  ).resolves.toMatchObject({ rows: [] })
  await expect(
    pool.query(`SELECT id FROM ${mappingTable} WHERE child_organization_id=$1`, [f.child]),
  ).resolves.toMatchObject({ rowCount: 2 })
  await expect(
    pool.query(
      'SELECT indexname FROM pg_indexes WHERE indexname = ANY($1::text[]) ORDER BY indexname',
      [['scim_team_managed_memberships_mapping_idx', 'scim_team_mappings_live_connection_idx']],
    ),
  ).resolves.toMatchObject({
    rows: [
      { indexname: 'scim_team_managed_memberships_mapping_idx' },
      { indexname: 'scim_team_mappings_live_connection_idx' },
    ],
  })
}

async function assertConsents(pool: pg.Pool, f: Teams) {
  const intentId = randomUUID()
  // Random counterpart and connection IDs are intentional: recording an initial
  // approval must not disclose whether the other organization or connection exists.
  const child = randomUUID()
  const input = {
    ...endpoints(f.parent, child, randomUUID()),
    action: 'link',
    external_id: 'Engineering',
    link_generation: 0,
    allow_group_retirement: true,
  }
  await refuse(
    insert(pool, intentsTable, { ...input, child_organization_id: f.parent }),
    '23514',
    'scim_team_mapping_intents_distinct_teams',
  )
  await refuse(
    insert(pool, intentsTable, { ...input, allow_group_retirement: false }),
    '23514',
    'scim_team_mapping_intents_input',
  )
  await refuse(
    insert(pool, intentsTable, { ...input, action: 'unlink' }),
    '23514',
    'scim_team_mapping_intents_input',
  )
  await refuse(
    insert(pool, intentsTable, { ...input, consumed_at: new Date(0) }),
    '23514',
    'scim_team_mapping_intents_lifetime',
  )
  for (const column of [
    'parent_organization_id',
    'child_organization_id',
    'connection_id',
    'created_at',
    'action',
  ]) {
    await expect(insert(pool, intentsTable, { ...input, [column]: null })).rejects.toMatchObject({
      code: '23502',
      table: intentsTable,
      column,
    })
  }
  await accept(insert(pool, intentsTable, { ...input, id: intentId }))
  await accept(
    insert(pool, intentsTable, {
      ...endpoints(f.parent, child, input.connection_id),
      action: 'unlink',
      mapping_id: randomUUID(),
    }),
  )
  await refuse(
    pool.query(`UPDATE ${intentsTable} SET external_id='other' WHERE id=$1`, [intentId]),
    '23514',
    'scim_team_mapping_intents_identity',
  )
  const proof = {
    owner_id: f.owner,
    member_id: f.member,
    session_id: randomUUID(),
    proof_kind: 'mailbox',
    proof_context: {},
    approved_at: '2026-11-21T00:00:00Z',
    expires_at: '2026-11-21T00:03:00Z',
  }
  const approval = { ...proof, intent_id: intentId, organization_id: f.parent }
  for (const column of Object.keys(proof)) {
    await expect(
      insert(pool, consentsTable, { ...approval, [column]: null }),
    ).rejects.toMatchObject({ code: '23502', table: consentsTable, column })
  }
  await refuse(
    insert(pool, consentsTable, { ...approval, organization_id: f.other }),
    '23514',
    'scim_team_mapping_consents_intent_side',
  )
  await refuse(
    insert(pool, consentsTable, { ...approval, proof_kind: 'recovery' }),
    '23514',
    'scim_team_mapping_consents_proof',
  )
  await refuse(
    insert(pool, consentsTable, { ...approval, proof_context: '[true]' }),
    '23514',
    'scim_team_mapping_consents_proof',
  )
  await refuse(
    insert(pool, consentsTable, { ...approval, expires_at: proof.approved_at }),
    '23514',
    'scim_team_mapping_consents_lifetime',
  )
  await accept(insert(pool, consentsTable, approval))
  await refuse(insert(pool, consentsTable, approval), '23505', 'scim_team_mapping_consents_pkey')
  await accept(insert(pool, consentsTable, { ...approval, organization_id: child }))
  await accept(
    pool.query(`UPDATE ${intentsTable} SET consumed_at=clock_timestamp() WHERE id=$1`, [intentId]),
  )
  await refuse(
    pool.query(`UPDATE ${intentsTable} SET consumed_at=NULL WHERE id=$1`, [intentId]),
    '23514',
    'scim_team_mapping_intents_identity',
  )
  await refuse(
    pool.query(`UPDATE ${consentsTable} SET proof_kind='sso' WHERE intent_id=$1`, [intentId]),
    '23514',
    'scim_team_mapping_consents_intent_side',
  )
  await accept(pool.query(`DELETE FROM ${intentsTable} WHERE id=$1`, [intentId]))
  await expect(
    pool.query(`SELECT intent_id FROM ${consentsTable} WHERE intent_id=$1`, [intentId]),
  ).resolves.toMatchObject({ rows: [] })
}

describe.skipIf(!serverUrl)('SCIM team hierarchy constraint coverage', () => {
  it('fails a protection assertion when a new constraint, index or trigger is dropped', async () => {
    const allowList: Record<string, string> = {
      'constraint public.scim_team_mappings.scim_team_mappings_pkey':
        'Endpoint role foreign keys require this target primary key, which cannot be dropped in isolation.',
      'constraint public.scim_team_mappings.scim_team_mappings_live_child_scope':
        'Managed memberships reference this target key, which restates the primary key and cannot be dropped in isolation.',
      'constraint public.scim_team_mapping_intents.scim_team_mapping_intents_pkey':
        'Consent foreign keys require this target primary key, which cannot be dropped in isolation.',
    }
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration: '0181_scim_team_hierarchy.sql',
      assertions: async (pool) => {
        const teams = await seed(pool)
        await assertTopology(pool, teams)
        await assertInternalRows(pool, teams)
        await assertConsents(pool, teams)
      },
      allowList,
    })
    expect(report.problems).toEqual([])
    expect(report.results.filter((result) => result.status === 'covered')).toHaveLength(
      report.objects.length - Object.keys(allowList).length,
    )
  }, 600_000)
})
