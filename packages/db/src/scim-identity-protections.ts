// Behavioural assertions for 0073_scim_identity.sql, shared by the SCIM identity tests (which
// also apply source-copy mutations) and the constraint coverage run. Every check runs inside
// one rolled-back transaction on the seeded fixture below, so the fixed IDs never collide.
import type pg from 'pg'
import { expect } from 'vitest'

export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const org = id(1),
  otherOrg = id(2),
  account = id(3),
  otherAccount = id(4)
export const connection = id(5),
  otherConnection = id(6),
  user = id(7),
  otherUser = id(8)
export const member = id(9),
  otherMember = id(10),
  invitation = id(11),
  otherInvitation = id(12)
export const token = id(13),
  otherToken = id(14),
  claim = id(15),
  block = id(16)
export const userInsert = (extra = '', values = '', name = 'another') =>
  `INSERT INTO scim_users (organization_id,connection_id,user_name${extra}) VALUES ('${org}','${connection}','${name}'${values})`
export const claimInsert = (extra = '', values = '') =>
  `INSERT INTO scim_user_claims (organization_id,connection_id,scim_user_id,work_email,expires_at${extra}) VALUES ('${org}','${connection}','${user}','claim@example.test',now()+interval '1 hour'${values})`
export const blockInsert = (extra = '', values = '', source = 'local', kind = 'suspension') =>
  `INSERT INTO scim_membership_blocks (organization_id,user_id,source,kind${extra}) VALUES ('${org}','${account}','${source}','${kind}'${values})`
// A captured tombstone: the account is gone and only the normalized mailbox identifies it.
export const tombstoneInsert = (
  extra = '',
  values = '',
  kind = 'removal',
  mailbox = 'one@example.test',
) =>
  `INSERT INTO scim_membership_blocks (organization_id,user_id,identity_email,source,kind${extra}) VALUES ('${org}',NULL,'${mailbox}','local','${kind}'${values})`
export const accountInsert = (accountId: string, email: string) =>
  `INSERT INTO auth."user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('${accountId}','X',${email},true,now(),now())`
export const blockFor = (accountId: string, kind = 'removal', extra = '', values = '') =>
  `INSERT INTO scim_membership_blocks (organization_id,user_id,source,kind${extra}) VALUES ('${org}','${accountId}','local','${kind}'${values})`

export async function seed(client: pg.PoolClient) {
  await client.query(`
    INSERT INTO auth.organization (id,name,slug,"createdAt") VALUES
      ('${org}','One','one',now()),('${otherOrg}','Two','two',now());
    INSERT INTO auth."user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES
      ('${account}','One','one@example.test',true,now(),now()),('${otherAccount}','Two','two@example.test',true,now(),now());
    INSERT INTO auth.member (id,"organizationId","userId",role,"createdAt") VALUES
      ('${member}','${org}','${account}','member',now()),
      ('${otherMember}','${otherOrg}','${otherAccount}','member',now());
    INSERT INTO auth.invitation (id,"organizationId",email,role,status,"expiresAt","inviterId") VALUES
      ('${invitation}','${org}','one@example.test','member','pending',now()+interval '1 hour','${account}'),
      ('${otherInvitation}','${otherOrg}','two@example.test','member','pending',now()+interval '1 hour','${otherAccount}');
    INSERT INTO scim_connections (id,organization_id) VALUES
      ('${connection}','${org}'),('${otherConnection}','${otherOrg}');
    INSERT INTO scim_provisioning_tokens (id,organization_id,name,token_hash) VALUES
      ('${token}','${org}','Synthetic one',repeat('a',43)),
      ('${otherToken}','${otherOrg}','Synthetic two',repeat('b',43));
    INSERT INTO scim_users (id,organization_id,connection_id,user_name,external_id,linked_user_id,linked_member_id) VALUES
      ('${user}','${org}','${connection}','Alice','Case-Sensitive','${account}','${member}'),
      ('${otherUser}','${otherOrg}','${otherConnection}','Alice','Case-Sensitive','${otherAccount}','${otherMember}');
  `)
}

export interface Protection {
  name: string
  sql: string
  code: string
  setup?: string
  mutation?: 'index' | 'trigger'
}
export const check = (name: string, sql: string, setup?: string): Protection => ({
  name,
  sql,
  setup,
  code: '23514',
})
export const fk = (name: string, sql: string, setup?: string): Protection => ({
  name,
  sql,
  setup,
  code: '23503',
})
export const unique = (name: string, sql: string, setup?: string): Protection => ({
  name,
  sql,
  setup,
  code: '23505',
  mutation: 'index',
})
export const protections: Protection[] = [
  {
    name: 'scim_connections_one_per_organization',
    sql: `INSERT INTO scim_connections(organization_id) VALUES ('${org}')`,
    code: '23505',
  },
  fk(
    'scim_token_connections_token_scope',
    `INSERT INTO scim_token_connections VALUES ('${otherToken}','${org}','${connection}')`,
    `DELETE FROM scim_token_connections WHERE token_id='${otherToken}'`,
  ),
  fk(
    'scim_token_connections_connection_scope',
    `UPDATE scim_token_connections SET connection_id='${otherConnection}' WHERE token_id='${token}'`,
  ),
  fk(
    'scim_users_connection_scope',
    `INSERT INTO scim_users(organization_id,connection_id,user_name) VALUES ('${org}','${otherConnection}','wrong')`,
  ),
  fk(
    'scim_users_member_scope',
    userInsert(',linked_user_id,linked_member_id', `,'${otherAccount}','${otherMember}'`),
  ),
  fk(
    'scim_users_manager_scope',
    `UPDATE scim_users SET manager_id='${otherUser}' WHERE id='${user}'`,
  ),
  check('scim_users_username_length', userInsert('', '', '   ')),
  check('scim_users_external_id_length', userInsert(',external_id', ",''")),
  check('scim_users_member_account', userInsert(',linked_member_id', `,'${member}'`)),
  check('scim_users_retired_inactive', userInsert(',retired_at', ',now()')),
  check('scim_users_profile_bounds', userInsert(',display_name', ",repeat('a',257)")),
  unique('scim_users_live_username', userInsert('', '', ' aLiCe ')),
  unique('scim_users_live_external_id', userInsert(',external_id', ",'Case-Sensitive'")),
  unique('scim_users_live_account', userInsert(',linked_user_id', `,'${account}'`)),
  fk(
    'scim_claims_user_scope',
    `INSERT INTO scim_user_claims(organization_id,connection_id,scim_user_id,work_email,expires_at) VALUES ('${org}','${connection}','${otherUser}','x@example.test',now()+interval '1 hour')`,
  ),
  fk('scim_claims_invitation_scope', claimInsert(',invitation_id', `,'${otherInvitation}'`)),
  check(
    'scim_claims_email_length',
    `INSERT INTO scim_user_claims(organization_id,connection_id,scim_user_id,work_email,expires_at) VALUES ('${org}','${connection}','${user}',' ',now()+interval '1 hour')`,
  ),
  check(
    'scim_claims_expiry',
    `INSERT INTO scim_user_claims(organization_id,connection_id,scim_user_id,work_email,expires_at) VALUES ('${org}','${connection}','${user}','x@example.test',now())`,
  ),
  check('scim_claims_terminal', claimInsert(',completed_at,invalidated_at', ',now(),now()')),
  unique('scim_claims_pending_user', claimInsert(), claimInsert()),
  unique(
    'scim_claims_invitation',
    claimInsert(',invitation_id', `,'${invitation}'`),
    claimInsert(',invitation_id,completed_at', `,'${invitation}',now()`),
  ),
  check('scim_blocks_source', blockInsert('', '', 'unknown'), undefined),
  check('scim_blocks_kind', blockInsert('', '', 'local', 'unknown')),
  check('scim_blocks_resource', blockInsert('', '', 'scim')),
  fk(
    'scim_blocks_user_scope',
    blockInsert(',connection_id,scim_user_id', `,'${connection}','${otherUser}'`, 'scim'),
  ),
  unique('scim_blocks_live_authority', blockInsert(), blockInsert()),
  unique('scim_blocks_live_identity', tombstoneInsert(), tombstoneInsert()),
  {
    ...check('scim_users_preserve_identity', `DELETE FROM scim_users WHERE id='${user}'`),
    mutation: 'trigger',
  },
  {
    ...check(
      'scim_blocks_preserve_identity',
      `DELETE FROM scim_membership_blocks WHERE id='${block}'`,
      tombstoneInsert(',id', `,'${block}'`),
    ),
    mutation: 'trigger',
  },
]

export async function rejected(client: pg.PoolClient, protection: Protection) {
  if (protection.setup) await client.query(protection.setup)
  await client.query('SAVEPOINT negative_assertion')
  let code: string | undefined
  try {
    await client.query(protection.sql)
  } catch (error) {
    code = (error as { code: string }).code
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT negative_assertion')
  }
  expect(code, protection.name).toBe(protection.code)
}

export async function succeeds(client: pg.PoolClient, sql: string) {
  await client.query('SAVEPOINT positive_assertion')
  let code: string | undefined
  try {
    await client.query(sql)
  } catch (error) {
    code = (error as { code: string }).code
    await client.query('ROLLBACK TO SAVEPOINT positive_assertion')
  }
  expect(code).toBeUndefined()
}

/** Columns 0073 declares NOT NULL outside primary keys, each with a row that is valid otherwise. */
const requiredColumns: [
  table: string,
  setup: string | undefined,
  row: Record<string, unknown>,
  columns: string[],
][] = [
  [
    'scim_connections',
    `INSERT INTO auth.organization (id,name,slug,"createdAt") VALUES ('${id(90)}','Third','third',now())`,
    { organization_id: id(90), created_at: '2030-01-01T00:00Z' },
    ['organization_id', 'created_at'],
  ],
  [
    'scim_token_connections',
    `DELETE FROM scim_token_connections WHERE token_id='${otherToken}'`,
    { token_id: otherToken, organization_id: otherOrg, connection_id: otherConnection },
    ['organization_id', 'connection_id'],
  ],
  [
    'scim_users',
    undefined,
    {
      organization_id: org,
      connection_id: connection,
      user_name: 'required',
      active: true,
      created_at: '2030-01-01T00:00Z',
      updated_at: '2030-01-01T00:00Z',
    },
    ['organization_id', 'connection_id', 'user_name', 'active', 'created_at', 'updated_at'],
  ],
  [
    'scim_user_claims',
    undefined,
    {
      organization_id: org,
      connection_id: connection,
      scim_user_id: user,
      work_email: 'required@example.test',
      created_at: '2030-01-01T00:00Z',
      expires_at: '2030-01-01T01:00Z',
    },
    ['organization_id', 'connection_id', 'scim_user_id', 'work_email', 'created_at', 'expires_at'],
  ],
  [
    'scim_membership_blocks',
    undefined,
    {
      organization_id: org,
      user_id: account,
      source: 'local',
      kind: 'suspension',
      created_at: '2030-01-01T00:00Z',
    },
    ['organization_id', 'source', 'kind', 'created_at'],
  ],
]

/** Each required column rejects NULL with 23502 on that column, in its own savepoint. */
export async function requiredColumnsRejectNull(client: pg.PoolClient) {
  const outcomes: string[] = []
  for (const [table, setup, row, columns] of requiredColumns) {
    if (setup) await client.query(setup)
    for (const column of columns) {
      const values: Record<string, unknown> = { ...row, [column]: null }
      const fields = Object.keys(values)
      await client.query('SAVEPOINT probe')
      try {
        await client.query(
          `INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')})`,
          Object.values(values),
        )
        outcomes.push(`${table}.${column}: accepted`)
      } catch (error) {
        const { code, column: rejected } = error as { code?: unknown; column?: string }
        // Only integrity rejections are outcomes; anything else is a broken run.
        if (typeof code !== 'string' || !/^(23|22|P0)/.test(code)) throw error
        if (code !== '23502' || rejected !== column)
          outcomes.push(`${table}.${column}: ${code} ${rejected ?? ''}`.trim())
      }
      await client.query('ROLLBACK TO SAVEPOINT probe')
    }
  }
  expect(outcomes).toEqual([])
}

/** Indexes that serve FK checks, deletion cleanup and tombstone lookups, with their columns. */
export const supportingIndexes: [name: string, columns: string][] = [
  ['scim_token_connections_connection_idx', 'organization_id, connection_id'],
  ['scim_users_member_idx', 'organization_id, linked_member_id, linked_user_id'],
  ['scim_users_account_idx', 'linked_user_id'],
  ['scim_users_manager_idx', 'organization_id, connection_id, manager_id'],
  ['scim_claims_user_idx', 'organization_id, connection_id, scim_user_id'],
  ['scim_claims_invitation_idx', 'organization_id, invitation_id'],
  ['scim_blocks_user_idx', 'user_id'],
  ['scim_blocks_resource_idx', 'organization_id, connection_id, scim_user_id'],
  ['scim_blocks_identity_idx', 'organization_id, identity_email'],
]

export async function supportingIndex(client: pg.PoolClient, name: string, columns: string) {
  const result = await client.query(
    "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname=$1",
    [name],
  )
  expect(result.rows).toHaveLength(1)
  expect(result.rows[0].indexdef).toContain(`(${columns})`)
}

/** Duplicate IDs that only the primary key rejects. */
export const primaryKeys: { table: string; name: string; sql: string; setup?: string }[] = [
  {
    table: 'scim_connections',
    name: 'scim_connections_pkey',
    sql: `INSERT INTO scim_connections(id,organization_id) VALUES ('${connection}','${id(90)}')`,
    setup: `INSERT INTO auth.organization(id,name,slug,"createdAt") VALUES ('${id(90)}','Third','third',now())`,
  },
  {
    table: 'scim_token_connections',
    name: 'scim_token_connections_pkey',
    sql: `INSERT INTO scim_token_connections VALUES ('${token}','${org}','${connection}')`,
  },
  {
    table: 'scim_users',
    name: 'scim_users_pkey',
    sql: `INSERT INTO scim_users(id,organization_id,connection_id,user_name) VALUES ('${user}','${otherOrg}','${otherConnection}','different')`,
  },
  {
    table: 'scim_user_claims',
    name: 'scim_user_claims_pkey',
    sql: claimInsert(',id,completed_at', `,'${claim}',now()`),
    setup: claimInsert(',id,completed_at', `,'${claim}',now()`),
  },
  {
    table: 'scim_membership_blocks',
    name: 'scim_membership_blocks_pkey',
    sql: blockInsert(',id,cleared_at', `,'${block}',now()`),
    setup: blockInsert(',id,cleared_at', `,'${block}',now()`),
  },
]

/** References to rows that do not exist, which only the named single-column FK rejects. */
export const danglingReferences: { table: string; name: string; sql: string }[] = [
  {
    table: 'scim_connections',
    name: 'scim_connections_organization_id_fkey',
    sql: `INSERT INTO scim_connections(organization_id) VALUES ('${id(99)}')`,
  },
  {
    table: 'scim_users',
    name: 'scim_users_linked_user_id_fkey',
    sql: userInsert(',linked_user_id', `,'${id(99)}'`),
  },
  {
    table: 'scim_membership_blocks',
    name: 'scim_membership_blocks_organization_id_fkey',
    sql: `INSERT INTO scim_membership_blocks(organization_id,user_id,source,kind) VALUES ('${id(99)}','${account}','local','removal')`,
  },
  {
    table: 'scim_membership_blocks',
    name: 'scim_membership_blocks_user_id_fkey',
    sql: `INSERT INTO scim_membership_blocks(organization_id,user_id,source,kind) VALUES ('${org}','${id(99)}','local','removal')`,
  },
]

/** Tombstone rows without an identity or with an unnormalized mailbox. */
export const tombstoneShapes: Protection[] = [
  check(
    'scim_blocks_identity',
    `INSERT INTO scim_membership_blocks(organization_id,source,kind) VALUES ('${org}','local','removal')`,
  ),
  check(
    'scim_blocks_identity_email',
    blockInsert(',identity_email', ",' UNNORMALIZED@example.test '"),
  ),
]

export async function tokenBindings(client: pg.PoolClient) {
  expect(
    (
      await client.query(
        `SELECT token_id,organization_id,connection_id FROM scim_token_connections ORDER BY token_id`,
      )
    ).rows,
  ).toEqual([
    { token_id: token, organization_id: org, connection_id: connection },
    { token_id: otherToken, organization_id: otherOrg, connection_id: otherConnection },
  ])
}

export async function accountDeletionClearsLinks(client: pg.PoolClient) {
  await client.query(blockInsert('', '', 'local', 'removal'))
  await client.query(
    blockInsert(',connection_id,scim_user_id', `,'${connection}','${user}'`, 'scim'),
  )
  await client.query(blockInsert(',cleared_at', ',now()'))
  await client.query(`INSERT INTO scim_membership_blocks (organization_id,user_id,source,kind)
    VALUES ('${otherOrg}','${otherAccount}','local','removal')`)
  await client.query('SAVEPOINT account_delete')
  let code: string | undefined
  try {
    await client.query(`DELETE FROM auth."user" WHERE id='${account}'`)
  } catch (error) {
    code = (error as { code: string }).code
  }
  if (code) await client.query('ROLLBACK TO SAVEPOINT account_delete')
  expect(code).toBeUndefined()
  expect(
    (
      await client.query(
        `SELECT linked_user_id,linked_member_id FROM scim_users WHERE id='${user}'`,
      )
    ).rows,
  ).toEqual([{ linked_user_id: null, linked_member_id: null }])
  expect(
    (
      await client.query(
        `SELECT linked_user_id,linked_member_id FROM scim_users WHERE id='${otherUser}'`,
      )
    ).rows,
  ).toEqual([{ linked_user_id: otherAccount, linked_member_id: otherMember }])
  expect(
    (
      await client.query(
        `SELECT user_id,identity_email,source,kind,cleared_at IS NOT NULL AS cleared FROM scim_membership_blocks WHERE organization_id='${org}' ORDER BY source,kind`,
      )
    ).rows,
  ).toEqual([
    {
      user_id: null,
      identity_email: 'one@example.test',
      source: 'local',
      kind: 'removal',
      cleared: false,
    },
    {
      user_id: null,
      identity_email: 'one@example.test',
      source: 'local',
      kind: 'suspension',
      cleared: true,
    },
    {
      user_id: null,
      identity_email: 'one@example.test',
      source: 'scim',
      kind: 'suspension',
      cleared: false,
    },
  ])
  expect(
    (
      await client.query(
        `SELECT user_id,identity_email FROM scim_membership_blocks WHERE organization_id='${otherOrg}'`,
      )
    ).rows,
  ).toEqual([{ user_id: otherAccount, identity_email: null }])
  expect((await client.query(`SELECT id FROM auth.member WHERE id='${otherMember}'`)).rows).toEqual(
    [{ id: otherMember }],
  )
}

/**
 * Fires the referential actions of the given foreign keys, which share one referenced table,
 * in this order.
 *
 * PostgreSQL fires a table's referential actions in RI trigger name order. The names embed
 * the trigger OID (RI_ConstraintTrigger_a_<oid>) and compare bytewise, so a later trigger
 * sorts first once its OID has more digits ('..._a_100002' < '..._a_99998'). The natural
 * order therefore depends on where the cluster's OID counter stood while the migrations ran.
 * This re-creates the foreign keys consecutively, each from its own definition (only the
 * trigger OIDs change), checks the order PostgreSQL uses (bytewise, COLLATE "C") and redoes
 * them while an OID power of ten between them reverses it.
 *
 * Only an entry marked optional may be missing, and it is then left out: the coverage run
 * drops that foreign key, and the assertions then see the missing cascade itself. Any other
 * missing foreign key (dropped or renamed) fails as setup, because ordering fewer foreign
 * keys than listed would compare a shorter list that always matches and enforce nothing.
 */
export async function fireCascadesInOrder(
  client: pg.PoolClient,
  cascades: readonly (readonly [
    table: string,
    constraint: string,
    options?: { readonly optional: true },
  ])[],
) {
  let fired: string[] = []
  for (let attempt = 1; attempt <= 3; attempt++) {
    const present: string[] = []
    for (const [table, name, options] of cascades) {
      const { rows } = await client.query(
        'SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2',
        [table, name],
      )
      if (!rows[0]) {
        if (options?.optional) continue
        throw new Error(
          `Setup could not fire the cascades in order: ${table} has no foreign key "${name}"`,
        )
      }
      present.push(name)
      await client.query(`ALTER TABLE ${table} DROP CONSTRAINT "${name}";
        ALTER TABLE ${table} ADD CONSTRAINT "${name}" ${rows[0].definition}`)
    }
    const { rows } = await client.query(
      `SELECT c.conname, t.tgname::text AS tgname
         FROM pg_trigger t JOIN pg_constraint c ON c.oid = t.tgconstraint
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = c.confrelid AND p.proname LIKE 'RI_FKey_%_del' AND c.conname = ANY($1)
        ORDER BY t.tgname COLLATE "C"`,
      [present],
    )
    fired = rows.map((row) => `${row.conname} (${row.tgname})`)
    if (rows.map((row) => row.conname).join() === present.join()) return
  }
  // A misordered setup fails here as setup, never later as a surviving or killed mutant.
  throw new Error(`Setup could not fire the cascades in order: ${fired.join(', ')}`)
}

export async function organizationDeletionCascades(client: pg.PoolClient) {
  // Adverse order for the claim cleanup: the invitation SET NULL runs before the connection
  // cascade has reached the claims, and rechecks a claim whose SCIM user is already deleted
  // (23503) unless the cleanup trigger removed the claims first. In the opposite order the
  // cascade deletes the claims itself and a missing cleanup would go unnoticed. Only the
  // connection FK comes from 0073, so it is the only one the coverage run drops.
  await fireCascadesInOrder(client, [
    ['auth.invitation', 'invitation_organizationId_fkey'],
    ['scim_connections', 'scim_connections_organization_id_fkey', { optional: true }],
  ])
  await client.query(claimInsert(',invitation_id', `,'${invitation}'`))
  await client.query(`INSERT INTO scim_user_claims (organization_id,connection_id,scim_user_id,invitation_id,work_email,expires_at)
    VALUES ('${otherOrg}','${otherConnection}','${otherUser}','${otherInvitation}','other@example.test',now()+interval '1 hour')`)
  await client.query(`INSERT INTO scim_membership_blocks (organization_id,user_id,source,kind)
    VALUES ('${otherOrg}','${otherAccount}','local','removal')`)
  await client.query(blockInsert())
  await client.query(
    blockInsert(',connection_id,scim_user_id', `,'${connection}','${user}'`, 'scim'),
  )
  // Captured tombstones refuse direct deletion but cascade with their organization.
  await client.query(tombstoneInsert())
  await client.query(tombstoneInsert(',cleared_at', ',now()', 'suspension'))
  await client.query('SAVEPOINT organization_delete')
  let code: string | undefined
  try {
    await client.query(`DELETE FROM auth.organization WHERE id='${org}'`)
  } catch (error) {
    code = (error as { code: string }).code
  }
  if (code) await client.query('ROLLBACK TO SAVEPOINT organization_delete')
  expect(code).toBeUndefined()
  for (const table of [
    'scim_connections',
    'scim_token_connections',
    'scim_users',
    'scim_user_claims',
    'scim_membership_blocks',
  ])
    expect(
      (await client.query(`SELECT organization_id FROM ${table} WHERE organization_id='${org}'`))
        .rows,
    ).toEqual([])
  expect(
    (await client.query(`SELECT organization_id,scim_user_id,invitation_id FROM scim_user_claims`))
      .rows,
  ).toEqual([
    { organization_id: otherOrg, scim_user_id: otherUser, invitation_id: otherInvitation },
  ])
  expect(
    (await client.query(`SELECT organization_id,user_id FROM scim_membership_blocks`)).rows,
  ).toEqual([{ organization_id: otherOrg, user_id: otherAccount }])
  expect((await client.query(`SELECT id FROM scim_users`)).rows).toEqual([{ id: otherUser }])
  expect((await client.query(`SELECT id FROM auth."user" ORDER BY id`)).rows).toEqual([
    { id: account },
    { id: otherAccount },
  ])
}

/**
 * Without the seed: the token trigger's ON CONFLICT target is this key, so seeding a token
 * without it fails with a non-integrity error instead of an assertion.
 */
export async function oneConnectionPerOrganization(client: pg.PoolClient) {
  await client.query(
    `INSERT INTO auth.organization (id,name,slug,"createdAt") VALUES ('${org}','One','one',now())`,
  )
  await client.query(
    `INSERT INTO scim_connections (id,organization_id) VALUES ('${connection}','${org}')`,
  )
  await rejected(
    client,
    protections.find(
      (protection) => protection.name === 'scim_connections_one_per_organization',
    ) as Protection,
  )
}

type ScimCheck = (client: pg.PoolClient) => Promise<void>

/**
 * The protection suite for the 0073 constraint coverage run: each check in its own
 * rolled-back transaction, seeded unless noted. The error names the first failing check.
 */
export async function assertScimIdentityProtections(pool: pg.Pool): Promise<void> {
  const checks: [name: string, check: ScimCheck, seeded: boolean][] = [
    // First, and unseeded: the seed creates tokens, whose trigger needs this key.
    ['one connection per organization', oneConnectionPerOrganization, false],
    ['required columns', requiredColumnsRejectNull, true],
    [
      'supporting indexes',
      async (client) => {
        for (const [name, columns] of supportingIndexes)
          await supportingIndex(client, name, columns)
      },
      true,
    ],
    ...protections.map((protection): [string, ScimCheck, boolean] => [
      protection.name,
      (client) => rejected(client, protection),
      true,
    ]),
    ...primaryKeys.map((entry): [string, ScimCheck, boolean] => [
      entry.name,
      (client) => rejected(client, { ...entry, code: '23505' }),
      true,
    ]),
    ...danglingReferences.map((entry): [string, ScimCheck, boolean] => [
      entry.name,
      (client) => rejected(client, { ...entry, code: '23503' }),
      true,
    ]),
    ...tombstoneShapes.map((protection): [string, ScimCheck, boolean] => [
      protection.name,
      (client) => rejected(client, protection),
      true,
    ]),
    ['token creation binds the organization connection', tokenBindings, true],
    ['account deletion clears links and keeps blockers', accountDeletionClearsLinks, true],
    ['organization deletion cascades its graph', organizationDeletionCascades, true],
  ]
  for (const [name, check, seeded] of checks) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      if (seeded) await seed(client)
      await check(client)
    } catch (error) {
      if (error instanceof Error) error.message = `[${name}] ${error.message}`
      throw error
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  }
}
