import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationsDir } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0073_scim_identity.sql'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const org = id(1),
  otherOrg = id(2),
  account = id(3),
  otherAccount = id(4)
const connection = id(5),
  otherConnection = id(6),
  user = id(7),
  otherUser = id(8)
const member = id(9),
  otherMember = id(10),
  invitation = id(11),
  otherInvitation = id(12)
const token = id(13),
  otherToken = id(14),
  claim = id(15),
  block = id(16)
const userInsert = (extra = '', values = '', name = 'another') =>
  `INSERT INTO scim_users (organization_id,connection_id,user_name${extra}) VALUES ('${org}','${connection}','${name}'${values})`
const claimInsert = (extra = '', values = '') =>
  `INSERT INTO scim_user_claims (organization_id,connection_id,scim_user_id,work_email,expires_at${extra}) VALUES ('${org}','${connection}','${user}','claim@example.test',now()+interval '1 hour'${values})`
const blockInsert = (extra = '', values = '', source = 'local', kind = 'suspension') =>
  `INSERT INTO scim_membership_blocks (organization_id,user_id,source,kind${extra}) VALUES ('${org}','${account}','${source}','${kind}'${values})`

async function seed(client: pg.PoolClient) {
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

interface Protection {
  name: string
  sql: string
  code: string
  setup?: string
  mutation?: 'index' | 'trigger'
}
const check = (name: string, sql: string, setup?: string): Protection => ({
  name,
  sql,
  setup,
  code: '23514',
})
const fk = (name: string, sql: string, setup?: string): Protection => ({
  name,
  sql,
  setup,
  code: '23503',
})
const unique = (name: string, sql: string, setup?: string): Protection => ({
  name,
  sql,
  setup,
  code: '23505',
  mutation: 'index',
})
const protections: Protection[] = [
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
  {
    ...check('scim_users_preserve_identity', `DELETE FROM scim_users WHERE id='${user}'`),
    mutation: 'trigger',
  },
]

// Remove only one named clause in a private SQL source copy. Balanced parentheses keep
// nested CHECK expressions intact; schema setup errors are never counted as a killed mutant.
function removeProtection(source: string, protection: Protection): string {
  if (protection.mutation === 'index')
    return source.replace(new RegExp(`CREATE UNIQUE INDEX ${protection.name}\\b[^;]+;`), '')
  if (protection.mutation === 'trigger')
    return source.replace(new RegExp(`CREATE TRIGGER ${protection.name}\\b[^;]+;`), '')
  const start = source.indexOf(`CONSTRAINT ${protection.name} `)
  expect(start).toBeGreaterThanOrEqual(0)
  let depth = 0,
    end = start
  for (; end < source.length; end++) {
    const char = source[end]
    if (char === '(') depth++
    else if (char === ')') {
      if (depth === 0) break
      depth--
    } else if (char === ',' && depth === 0) break
  }
  if (source[end] === ',') return source.slice(0, start) + source.slice(end + 1)
  const comma = source.lastIndexOf(',', start)
  return source.slice(0, comma) + source.slice(end)
}

async function rejected(client: pg.PoolClient, protection: Protection) {
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

describe.skipIf(!serverUrl)('SCIM identity storage', () => {
  let database: TestDatabase
  let source: string
  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-scim-identity-controls-'))
    try {
      for (const file of (await readdir(migrationsDir)).filter(
        (f) => f.endsWith('.sql') && f !== migration,
      ))
        await copyFile(join(migrationsDir, file), join(directory, file))
      database = await createTestDatabase(serverUrl as string, directory)
      source = await readFile(join(migrationsDir, migration), 'utf8')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
  afterAll(async () => {
    await database?.drop()
  })

  async function transaction(sql: string, work: (client: pg.PoolClient) => Promise<void>) {
    const client = await database.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await seed(client)
      await work(client)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  }

  it.each(protections)('$name rejects invalid storage', async (protection) => {
    await transaction(source, (client) => rejected(client, protection))
  })
  it.each(protections)(
    '$name source-copy removal fails the real assertion, restored source passes',
    async (protection) => {
      let mutant = removeProtection(source, protection)
      // The one-per-organization key also supplies the INSERT trigger's conflict target.
      // No token fixture uses that trigger under this mutant: seed bindings explicitly.
      if (protection.name === 'scim_connections_one_per_organization') {
        mutant = mutant.replace(/CREATE TRIGGER scim_token_connection_insert\b[^;]+;/, '')
      }
      expect(mutant).not.toBe(source)
      await transaction(mutant, async (client) => {
        await expect(rejected(client, protection)).rejects.toMatchObject({ name: 'AssertionError' })
      })
      await transaction(source, (client) => rejected(client, protection))
    },
  )

  it('retired identifiers are reusable only with a fresh opaque ID and fresh claim; local blockers survive', async () => {
    await transaction(source, async (client) => {
      await client.query(blockInsert(',id', `,'${block}'`, 'local', 'removal'))
      await client.query(`UPDATE scim_users SET active=false,retired_at=now() WHERE id='${user}'`)
      const replacement = (
        await client.query<{ id: string }>(
          `${userInsert(',external_id,linked_user_id', `,'Case-Sensitive','${account}'`, 'ALICE')} RETURNING id`,
        )
      ).rows[0]
      if (!replacement) throw new Error('Expected a fresh SCIM resource')
      expect(replacement.id).not.toBe(user)
      expect(
        (await client.query(`SELECT id FROM scim_users WHERE retired_at IS NOT NULL`)).rows,
      ).toEqual([{ id: user }])
      expect(
        (await client.query(`SELECT id FROM scim_membership_blocks WHERE cleared_at IS NULL`)).rows,
      ).toEqual([{ id: block }])
      expect(
        (
          await client.query(`SELECT id FROM scim_user_claims WHERE scim_user_id=$1`, [
            replacement.id,
          ])
        ).rows,
      ).toEqual([])
      await rejected(
        client,
        check(
          'retirement cannot be cleared',
          `UPDATE scim_users SET retired_at=NULL,active=true WHERE id='${user}'`,
        ),
      )
      await rejected(
        client,
        check('identity cannot change', `UPDATE scim_users SET id='${id(99)}' WHERE id='${user}'`),
      )
    })
  })

  it('externalId is case sensitive, null IDs repeat, inactive live identities remain reserved and managers can link locally', async () => {
    await transaction(source, async (client) => {
      await client.query(userInsert(',external_id,manager_id', `,'case-sensitive','${user}'`))
      await client.query(userInsert('', '', 'null-one'))
      await client.query(userInsert('', '', 'null-two'))
      await client.query(`UPDATE scim_users SET active=false WHERE id='${user}'`)
      await rejected(
        client,
        protections.find((p) => p.name === 'scim_users_live_username') as Protection,
      )
      await rejected(
        client,
        protections.find((p) => p.name === 'scim_users_live_external_id') as Protection,
      )
    })
  })

  it('member/account mismatch is refused, native member deletion retains linked account and both blockers', async () => {
    await transaction(source, async (client) => {
      await rejected(
        client,
        fk(
          'member must belong to the linked account',
          userInsert(',linked_user_id,linked_member_id', `,'${otherAccount}','${member}'`),
        ),
      )
      await client.query(blockInsert())
      await client.query(
        blockInsert(',connection_id,scim_user_id', `,'${connection}','${user}'`, 'scim'),
      )
      await client.query(`DELETE FROM auth.member WHERE id='${member}'`)
      expect(
        (
          await client.query(
            `SELECT linked_user_id,linked_member_id FROM scim_users WHERE id='${user}'`,
          )
        ).rows,
      ).toEqual([{ linked_user_id: account, linked_member_id: null }])
      expect(
        (await client.query(`SELECT source FROM scim_membership_blocks ORDER BY source`)).rows,
      ).toEqual([{ source: 'local' }, { source: 'scim' }])
    })
  })

  it('deduplicated claims retain completed history, invitation deletion clears only its reference', async () => {
    await transaction(source, async (client) => {
      await client.query(claimInsert(',id,invitation_id', `,'${claim}','${invitation}'`))
      await client.query(`UPDATE scim_user_claims SET completed_at=now() WHERE id='${claim}'`)
      await client.query(claimInsert())
      await client.query(`DELETE FROM auth.invitation WHERE id='${invitation}'`)
      expect(
        (
          await client.query(
            `SELECT invitation_id,completed_at IS NOT NULL AS completed FROM scim_user_claims WHERE id='${claim}'`,
          )
        ).rows,
      ).toEqual([{ invitation_id: null, completed: true }])
    })
  })
  it.each([
    ['given_name', 256],
    ['family_name', 256],
    ['formatted_name', 256],
    ['display_name', 256],
    ['nick_name', 256],
    ['work_email', 320],
    ['locale', 64],
    ['timezone', 128],
    ['title', 256],
    ['user_type', 256],
    ['employee_number', 256],
    ['cost_center', 256],
    ['enterprise_organization', 256],
    ['division', 256],
    ['department', 256],
  ] as const)(
    '%s profile bound rejects excess and detects removal of that individual bound',
    async (column, limit) => {
      const protection = check(column, userInsert(`,${column}`, `,repeat('x',${limit + 1})`))
      const clause = `char_length(coalesce(${column}, '')) <= ${limit}`
      expect(source.includes(clause)).toBe(true)
      await transaction(source, async (client) => {
        await rejected(client, protection)
        await client.query(userInsert(`,${column}`, `,repeat('x',${limit})`))
      })
      await transaction(source.replace(clause, 'true'), async (client) => {
        await expect(rejected(client, protection)).rejects.toMatchObject({ name: 'AssertionError' })
      })
    },
  )

  it.each([
    check('username upper bound', userInsert('', '', 'x'.repeat(257))),
    check('externalId upper bound', userInsert(',external_id', ",repeat('x',1025)")),
    check(
      'claim mailbox upper bound',
      `INSERT INTO scim_user_claims(organization_id,connection_id,scim_user_id,work_email,expires_at) VALUES ('${org}','${connection}','${user}',repeat('x',321),now()+interval '1 hour')`,
    ),
    check(
      'local blocker cannot carry a resource',
      blockInsert(',connection_id,scim_user_id', `,'${connection}','${user}'`),
    ),
    check('SCIM blocker needs connection', blockInsert(',scim_user_id', `,'${user}'`, 'scim')),
    check('SCIM blocker needs resource', blockInsert(',connection_id', `,'${connection}'`, 'scim')),
  ])('$name rejects boundary and partial-reference bypasses', async (protection) => {
    await transaction(source, (client) => rejected(client, protection))
  })

  it.each(['id', 'organization_id', 'connection_id', 'retired_at'] as const)(
    '%s is immutable and identity-trigger removal fails its assertion',
    async (column) => {
      const protection = check(
        column,
        `UPDATE scim_users SET ${column}=${column === 'retired_at' ? "now()+interval '1 second'" : `'${id(99)}'`} WHERE id='${user}'`,
        column === 'retired_at'
          ? `UPDATE scim_users SET active=false,retired_at=now() WHERE id='${user}'`
          : undefined,
      )
      // Other foreign keys must remain valid so this test isolates the identity trigger.
      if (column === 'organization_id' || column === 'connection_id')
        protection.sql = `UPDATE scim_users SET organization_id='${otherOrg}',connection_id='${otherConnection}',user_name='moved',external_id=NULL,linked_member_id=NULL,linked_user_id=NULL WHERE id='${user}'`
      await transaction(source, (client) => rejected(client, protection))
      await transaction(
        source.replace(/CREATE TRIGGER scim_users_preserve_identity\b[^;]+;/, ''),
        async (client) => {
          await expect(rejected(client, protection)).rejects.toMatchObject({
            name: 'AssertionError',
          })
        },
      )
    },
  )

  it('token creation automatically binds the organization connection; source-copy trigger removal fails', async () => {
    const verify = async (client: pg.PoolClient) => {
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
    await transaction(source, verify)
    await transaction(
      source.replace(/CREATE TRIGGER scim_token_connection_insert\b[^;]+;/, ''),
      async (client) => {
        await expect(verify(client)).rejects.toMatchObject({ name: 'AssertionError' })
      },
    )
  })

  it('native account deletion preserves the resource and clears both links; removing cleanup trigger fails the assertion', async () => {
    const verify = async (client: pg.PoolClient) => {
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
    }
    await transaction(source, verify)
    const mutant = source.replace(/CREATE TRIGGER scim_account_delete_links\b[^;]+;/, '')
    expect(mutant).not.toBe(source)
    await transaction(mutant, async (client) => {
      await expect(verify(client)).rejects.toMatchObject({ name: 'AssertionError' })
    })
  })

  it('whole-organization deletion cascades its graph and removing the claim cleanup guard fails the success assertion', async () => {
    const verify = async (client: pg.PoolClient) => {
      await client.query(claimInsert(',invitation_id', `,'${invitation}'`))
      await client.query(blockInsert())
      await client.query(
        blockInsert(',connection_id,scim_user_id', `,'${connection}','${user}'`, 'scim'),
      )
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
          (
            await client.query(
              `SELECT organization_id FROM ${table} WHERE organization_id='${org}'`,
            )
          ).rows,
        ).toEqual([])
      expect((await client.query(`SELECT id FROM scim_users`)).rows).toEqual([{ id: otherUser }])
      expect((await client.query(`SELECT id FROM auth."user" ORDER BY id`)).rows).toEqual([
        { id: account },
        { id: otherAccount },
      ])
    }
    await transaction(source, verify)
    const mutant = source.replace(/CREATE TRIGGER scim_organization_delete_claims\b[^;]+;/, '')
    expect(mutant).not.toBe(source)
    await transaction(mutant, async (client) => {
      await expect(verify(client)).rejects.toMatchObject({ name: 'AssertionError' })
    })
  })
  const primaryKeys = [
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
  it.each(primaryKeys)(
    '$name rejects duplicate IDs and source-copy removal fails the same assertion',
    async (entry) => {
      const protection = { ...entry, code: '23505' }
      await transaction(source, (client) => rejected(client, protection))
      // Append a destructive alteration to a private source copy, after dependencies exist.
      // CASCADE removes dependent FK metadata, never concealing a migration setup failure.
      await transaction(
        `${source}\nALTER TABLE ${entry.table} DROP CONSTRAINT ${entry.name} CASCADE;`,
        async (client) => {
          await expect(rejected(client, protection)).rejects.toMatchObject({
            name: 'AssertionError',
          })
        },
      )
    },
  )

  it.each([
    ['scim_connections', 'scim_connections_scope'],
    ['scim_provisioning_tokens', 'scim_tokens_scope'],
    ['auth.member', 'scim_member_scope'],
    ['auth.invitation', 'scim_invitation_scope'],
    ['scim_users', 'scim_users_scope'],
  ])(
    '%s supporting candidate key %s is retained and its removal fails the catalog assertion',
    async (table, name) => {
      // These composite keys are logically implied by global PKs, but PostgreSQL requires
      // their exact column shape to support scoped FKs. Test that structural requirement
      // explicitly, separately from every scoped FK's behavioral cross-org negative above.
      const verify = async (client: pg.PoolClient) => {
        expect(
          (
            await client.query(
              `SELECT contype FROM pg_constraint WHERE conname=$1 AND conrelid=$2::regclass`,
              [name, table],
            )
          ).rows,
        ).toEqual([{ contype: 'u' }])
      }
      await transaction(source, verify)
      await transaction(
        `${source}\nALTER TABLE ${table} DROP CONSTRAINT ${name} CASCADE;`,
        async (client) => {
          await expect(verify(client)).rejects.toMatchObject({ name: 'AssertionError' })
        },
      )
    },
  )

  it.each(['lower(btrim(user_name))', 'btrim(user_name)'])(
    '%s generated normalization protects stored identity; removal fails actual value assertion',
    async (expression) => {
      const verify = async (client: pg.PoolClient) => {
        const result = await client.query(
          `${userInsert('', '', '  MiXeD  ')} RETURNING normalized_user_name`,
        )
        expect(result.rows).toEqual([{ normalized_user_name: 'mixed' }])
      }
      await transaction(source, verify)
      const mutant = expression.startsWith('lower')
        ? source.replace(expression, 'btrim(user_name)')
        : source.replace(expression, 'user_name')
      expect(mutant).not.toBe(source)
      await transaction(mutant, async (client) => {
        await expect(verify(client)).rejects.toMatchObject({ name: 'AssertionError' })
      })
    },
  )
  it.each([
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
  ])(
    '$name rejects dangling references and removing it fails the same assertion',
    async (entry) => {
      const protection = { ...entry, code: '23503' }
      await transaction(source, (client) => rejected(client, protection))
      await transaction(
        `${source}\nALTER TABLE ${entry.table} DROP CONSTRAINT ${entry.name};`,
        async (client) => {
          await expect(rejected(client, protection)).rejects.toMatchObject({
            name: 'AssertionError',
          })
        },
      )
    },
  )
})
