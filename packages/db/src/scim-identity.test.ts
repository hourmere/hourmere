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
// A captured tombstone: the account is gone and only the normalized mailbox identifies it.
const tombstoneInsert = (extra = '', values = '', kind = 'removal', mailbox = 'one@example.test') =>
  `INSERT INTO scim_membership_blocks (organization_id,user_id,identity_email,source,kind${extra}) VALUES ('${org}',NULL,'${mailbox}','local','${kind}'${values})`
const accountInsert = (accountId: string, email: string) =>
  `INSERT INTO auth."user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('${accountId}','X',${email},true,now(),now())`
const blockFor = (accountId: string, kind = 'removal', extra = '', values = '') =>
  `INSERT INTO scim_membership_blocks (organization_id,user_id,source,kind${extra}) VALUES ('${org}','${accountId}','local','${kind}'${values})`
// Replace only the named column inside the tombstone trigger's decision tuple comparison.
function dropTupleColumn(source: string, column: string): string {
  const start = source.indexOf('CREATE FUNCTION scim_preserve_block_identity()')
  const end = source.indexOf('$$;', start)
  expect(start).toBeGreaterThan(0)
  const body = source.slice(start, end).replace(new RegExp(`(NEW|OLD)\\.${column}\\b`, 'g'), 'NULL')
  return source.slice(0, start) + body + source.slice(end)
}

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

async function succeeds(client: pg.PoolClient, sql: string) {
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
    '%s is independently immutable and removing only its comparison fails the assertion',
    async (column) => {
      const protection = check(
        column,
        `UPDATE scim_users SET ${column}=${column === 'retired_at' ? "now()+interval '1 second'" : `'${column === 'organization_id' ? otherOrg : column === 'connection_id' ? otherConnection : id(99)}'`},user_name='moved',external_id=NULL,linked_member_id=NULL,linked_user_id=NULL WHERE id='${user}'`,
        column === 'retired_at'
          ? `UPDATE scim_users SET active=false,retired_at=now() WHERE id='${user}'`
          : undefined,
      )
      // The scoped FK makes either move impossible in production. Remove it only in
      // this private fixture to isolate each defensive trigger branch independently.
      const fixture = `${column === 'retired_at' ? source.replace(/IF OLD.retired_at IS NOT NULL AND \([\s\S]*?END IF;/, '') : source}\nALTER TABLE scim_users DROP CONSTRAINT scim_users_connection_scope;`
      const mutant =
        column === 'retired_at'
          ? fixture.replace(
              'OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at',
              'false',
            )
          : fixture.replace(
              /\((NEW|OLD)\.id(?:, \1\.(?:organization_id|connection_id))*\)/g,
              (tuple) => tuple.replace(new RegExp(`(NEW|OLD)\\.${column}\\b`), 'NULL'),
            )
      await transaction(fixture, (client) => rejected(client, protection))
      expect(mutant).not.toBe(fixture)
      await transaction(mutant, async (client) => {
        await expect(rejected(client, protection)).rejects.toMatchObject({ name: 'AssertionError' })
      })
    },
  )

  it.each([
    {
      name: 'invalidated claims permit a fresh pending claim',
      setup: claimInsert(',invalidated_at', ',now()'),
      sql: claimInsert(),
      from: 'completed_at IS NULL AND invalidated_at IS NULL',
      to: 'completed_at IS NULL',
    },
    {
      name: 'cleared removal permits a fresh removal',
      setup: blockInsert(',cleared_at', ',now()', 'local', 'removal'),
      sql: blockInsert('', '', 'local', 'removal'),
      from: '(organization_id, user_id, source, kind)\n  WHERE cleared_at IS NULL;',
      to: '(organization_id, user_id, source, kind);',
    },
    {
      name: 'cleared removal is excluded even when suspension predicate remains',
      setup: blockInsert(',cleared_at', ',now()', 'local', 'removal'),
      sql: blockInsert('', '', 'local', 'removal'),
      from: '(organization_id, user_id, source, kind)\n  WHERE cleared_at IS NULL;',
      to: "(organization_id, user_id, source, kind)\n  WHERE cleared_at IS NULL OR kind = 'removal';",
    },
    {
      name: 'one authority may independently suspend and remove an account',
      setup: blockInsert(),
      sql: blockInsert('', '', 'local', 'removal'),
      from: '(organization_id, user_id, source, kind)',
      to: '(organization_id, user_id, source)',
    },
    {
      name: 'cleared mailbox tombstone permits a fresh tombstone for that mailbox',
      setup: tombstoneInsert(',cleared_at', ',now()'),
      sql: tombstoneInsert(),
      from: '(organization_id, identity_email, source, kind)\n  WHERE cleared_at IS NULL;',
      to: '(organization_id, identity_email, source, kind);',
    },
    {
      name: 'one mailbox may carry independent suspension and removal tombstones',
      setup: tombstoneInsert('', '', 'suspension'),
      sql: tombstoneInsert(),
      from: '(organization_id, identity_email, source, kind)',
      to: '(organization_id, identity_email, source)',
    },
  ])('$name and source-copy predicate mutation fails the success assertion', async (entry) => {
    const verify = async (client: pg.PoolClient) => {
      await client.query(entry.setup)
      await succeeds(client, entry.sql)
    }
    await transaction(source, verify)
    const mutant = source.replace(entry.from, entry.to)
    expect(mutant).not.toBe(source)
    await transaction(mutant, async (client) => {
      await expect(verify(client)).rejects.toMatchObject({ name: 'AssertionError' })
    })
  })

  it('connection deletion cannot silently discard bound credentials', async () => {
    const protection = fk(
      'connection deletion restriction',
      `DELETE FROM scim_connections WHERE id='${connection}'`,
      `DELETE FROM scim_token_connections WHERE token_id='${otherToken}'; DELETE FROM scim_provisioning_tokens WHERE id='${otherToken}';
       DELETE FROM auth.organization WHERE id='${otherOrg}';
       UPDATE scim_users SET linked_member_id=NULL,linked_user_id=NULL WHERE id='${user}';
       ALTER TABLE scim_users DISABLE TRIGGER scim_users_preserve_identity;
       DELETE FROM scim_users WHERE id='${user}'`,
    )
    await transaction(source, (client) => rejected(client, protection))
    const mutant = source.replace(
      'REFERENCES scim_connections (organization_id, id)\n);',
      'REFERENCES scim_connections (organization_id, id) ON DELETE CASCADE\n);',
    )
    expect(mutant).not.toBe(source)
    await transaction(mutant, async (client) => {
      await expect(rejected(client, protection)).rejects.toMatchObject({ name: 'AssertionError' })
    })
  })

  // Padded values keep the trimmed value short, so only the raw bound decides the outcome.
  it.each([
    ['user_name', 256, (length: number) => userInsert('', '', `${' '.repeat(length - 3)}pad`)],
    [
      'work_email',
      320,
      (length: number) =>
        `INSERT INTO scim_user_claims(organization_id,connection_id,scim_user_id,work_email,expires_at) VALUES ('${org}','${connection}','${user}',repeat(' ',${length - 3})||'a@b',now()+interval '1 hour')`,
    ],
  ] as const)(
    '%s raw length accepts exactly %i padded characters and rejects one more; removing or loosening the bound fails',
    async (column, limit, insert) => {
      const protection = check(`${column} raw length`, insert(limit + 1))
      const verify = async (client: pg.PoolClient) => {
        await rejected(client, protection)
        await succeeds(client, insert(limit))
      }
      await transaction(source, verify)
      const clause = `char_length(${column}) <= ${limit}`
      for (const replacement of ['true', `char_length(${column}) <= ${limit * 4}`]) {
        const mutant = source.replace(clause, replacement)
        expect(mutant).not.toBe(source)
        await transaction(mutant, async (client) => {
          await expect(verify(client)).rejects.toMatchObject({ name: 'AssertionError' })
        })
      }
    },
  )

  it.each([
    ['display_name', "'changed'"],
    ['user_name', "'changed'"],
    ['external_id', "'changed'"],
    ['manager_id', `'${id(80)}'`],
    ['created_at', "now()+interval '1 second'"],
    ['updated_at', "now()+interval '1 second'"],
    ['linked_user_id', `'${otherAccount}',linked_member_id=NULL`],
    ['linked_member_id', `'${id(81)}'`],
  ])(
    'retired %s cannot be rewritten while native link clearing remains allowed',
    async (column, value) => {
      const protection = check(
        `retired ${column}`,
        `UPDATE scim_users SET ${column}=${value} WHERE id='${user}'`,
        `${userInsert(',id', `,'${id(80)}'`, 'manager')};
       INSERT INTO auth.member (id,"organizationId","userId",role,"createdAt") VALUES ('${id(81)}','${org}','${account}','member',now());
       UPDATE scim_users SET active=false,retired_at=now() WHERE id='${user}'`,
      )
      await transaction(source, async (client) => {
        await rejected(client, protection)
        await succeeds(client, `DELETE FROM auth.member WHERE id='${member}'`)
        await succeeds(client, `DELETE FROM auth."user" WHERE id='${account}'`)
        expect(
          (
            await client.query(
              `SELECT linked_user_id,linked_member_id FROM scim_users WHERE id='${user}'`,
            )
          ).rows,
        ).toEqual([{ linked_user_id: null, linked_member_id: null }])
      })
      const mutant = source.replace(/IF OLD.retired_at IS NOT NULL AND \([\s\S]*?END IF;/, '')
      expect(mutant).not.toBe(source)
      await transaction(mutant, async (client) => {
        await expect(rejected(client, protection)).rejects.toMatchObject({ name: 'AssertionError' })
      })
    },
  )

  it.each([
    check(
      'scim_blocks_identity',
      `INSERT INTO scim_membership_blocks(organization_id,source,kind) VALUES ('${org}','local','removal')`,
    ),
    check(
      'scim_blocks_identity_email',
      blockInsert(',identity_email', ",' UNNORMALIZED@example.test '"),
    ),
  ])('$name rejects invalid tombstone storage and its source removal fails', async (protection) => {
    await transaction(source, (client) => rejected(client, protection))
    const mutant = removeProtection(source, protection)
    expect(mutant).not.toBe(source)
    await transaction(mutant, async (client) => {
      await expect(rejected(client, protection)).rejects.toMatchObject({ name: 'AssertionError' })
    })
  })

  it.each([
    ['identity_email', "'changed@example.test'"],
    ['identity_email', 'NULL'],
    ['organization_id', `'${otherOrg}'`],
    ['user_id', `'${otherAccount}'`],
  ])('captured tombstone %s cannot be redirected to %s', async (column, value) => {
    const protection = check(
      'scim_blocks_preserve_identity',
      `UPDATE scim_membership_blocks SET ${column}=${value} WHERE id='${block}'`,
      blockInsert(',id,identity_email', `,'${block}','one@example.test'`, 'local', 'removal'),
    )
    await transaction(source, (client) => rejected(client, protection))
    const mutant = source.replace(/CREATE TRIGGER scim_blocks_preserve_identity\b[^;]+;/, '')
    expect(mutant).not.toBe(source)
    await transaction(mutant, async (client) => {
      await expect(rejected(client, protection)).rejects.toMatchObject({ name: 'AssertionError' })
    })
  })

  it('captured identity survives account email changes and blocks a newly registered identity', async () => {
    const verify = async (client: pg.PoolClient) => {
      await client.query(blockInsert(',identity_email', ",'one@example.test'", 'local', 'removal'))
      await client.query(
        `UPDATE auth."user" SET email='renamed@example.test' WHERE id='${account}'`,
      )
      await succeeds(client, `DELETE FROM auth."user" WHERE id='${account}'`)
      await client.query(`INSERT INTO auth."user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES
        ('${id(95)}','Recreated','one@example.test',true,now(),now())`)
      expect(
        (
          await client.query(`SELECT b.user_id,b.kind FROM scim_membership_blocks b
        JOIN auth."user" u ON b.identity_email=lower(btrim(u.email))
        WHERE u.id='${id(95)}' AND b.organization_id='${org}' AND b.cleared_at IS NULL`)
        ).rows,
      ).toEqual([{ user_id: null, kind: 'removal' }])
    }
    await transaction(source, verify)
    // Capture that also rewrites an already captured mailbox with the current address.
    const mutant = source.replace(' AND b.identity_email IS NULL AND (', ' AND (')
    expect(mutant).not.toBe(source)
    await transaction(mutant, async (client) => {
      await expect(verify(client)).rejects.toMatchObject({ name: 'AssertionError' })
    })
  })

  it.each([
    {
      clause: 'lower()',
      value: "'Mixed@example.test'",
      from: '(identity_email = lower(btrim(identity_email)) AND',
      to: '(identity_email = btrim(identity_email) AND',
    },
    {
      clause: 'btrim() for leading whitespace',
      value: "' mixed@example.test'",
      from: '(identity_email = lower(btrim(identity_email)) AND',
      to: '(identity_email = lower(identity_email) AND',
    },
    {
      clause: 'btrim() for trailing whitespace',
      value: "'mixed@example.test '",
      from: '(identity_email = lower(btrim(identity_email)) AND',
      to: '(identity_email = lower(identity_email) AND',
    },
    {
      clause: '<= 320',
      value: "repeat('x',321)",
      from: 'char_length(identity_email) BETWEEN 1 AND 320)),',
      to: 'char_length(identity_email) >= 1)),',
    },
    {
      clause: '>= 1',
      value: "''",
      from: 'char_length(identity_email) BETWEEN 1 AND 320)),',
      to: 'char_length(identity_email) <= 320)),',
    },
  ])(
    'scim_blocks_identity_email $clause rejects $value and dropping only that clause fails the assertion',
    async (entry) => {
      const protection = check(
        `scim_blocks_identity_email ${entry.clause}`,
        blockInsert(',identity_email', `,${entry.value}`),
      )
      await transaction(source, async (client) => {
        await rejected(client, protection)
        // Exactly 320 normalized characters remain storable.
        await succeeds(
          client,
          blockInsert(',identity_email', ",repeat('x',307)||'@example.test'", 'local', 'removal'),
        )
      })
      const mutant = source.replace(entry.from, entry.to)
      expect(mutant).not.toBe(source)
      await transaction(mutant, async (client) => {
        await expect(rejected(client, protection)).rejects.toMatchObject({ name: 'AssertionError' })
      })
    },
  )

  it.each([
    ['id', `'${id(99)}'`],
    ['source', "'scim'"],
    ['kind', "'suspension'"],
    ['connection_id', `'${connection}'`],
    ['scim_user_id', `'${user}'`],
    ['created_at', "now()-interval '9 years'"],
  ])(
    'captured tombstone %s is immutable, live or cleared, while clearing stays possible; removing its comparison or freezing only live rows fails',
    async (column, value) => {
      const live = check(
        `captured ${column}`,
        `UPDATE scim_membership_blocks SET ${column}=${value} WHERE id='${block}'`,
        tombstoneInsert(',id', `,'${block}'`),
      )
      // Cleared history is frozen as well: the same mailbox and kind may coexist with the
      // live row because the live-identity index covers only uncleared tombstones.
      const cleared = check(
        `cleared captured ${column}`,
        `UPDATE scim_membership_blocks SET ${column}=${value} WHERE id='${id(17)}'`,
        tombstoneInsert(',id,cleared_at', `,'${id(17)}',now()`),
      )
      // The resource-shape CHECK would mask a lone authority or resource change. Drop it
      // only in this private fixture to isolate each column of the decision tuple.
      const fixture = `${source}\nALTER TABLE scim_membership_blocks DROP CONSTRAINT scim_blocks_resource;`
      const verify = async (client: pg.PoolClient) => {
        await rejected(client, live)
        await rejected(client, cleared)
        await succeeds(
          client,
          `UPDATE scim_membership_blocks SET cleared_at=now() WHERE id='${block}'`,
        )
      }
      await transaction(fixture, verify)
      for (const mutant of [
        dropTupleColumn(fixture, column),
        // The decision tuple frozen only while the tombstone is live.
        fixture.replace(
          '    (NEW.id, NEW.source, NEW.kind, NEW.connection_id, NEW.scim_user_id, NEW.created_at) IS DISTINCT FROM\n    (OLD.id, OLD.source, OLD.kind, OLD.connection_id, OLD.scim_user_id, OLD.created_at) OR',
          '    (OLD.cleared_at IS NULL AND (NEW.id, NEW.source, NEW.kind, NEW.connection_id, NEW.scim_user_id, NEW.created_at) IS DISTINCT FROM\n    (OLD.id, OLD.source, OLD.kind, OLD.connection_id, OLD.scim_user_id, OLD.created_at)) OR',
        ),
      ]) {
        expect(mutant).not.toBe(fixture)
        await transaction(mutant, async (client) => {
          await expect(verify(client)).rejects.toMatchObject({ name: 'AssertionError' })
        })
      }
    },
  )

  it('a captured tombstone cleared once cannot be uncleared, postponed or backdated; removing or narrowing the clause fails', async () => {
    const verify = async (client: pg.PoolClient) => {
      await client.query(
        `${tombstoneInsert(',id', `,'${block}'`)}; UPDATE scim_membership_blocks SET cleared_at=now() WHERE id='${block}'`,
      )
      for (const [value, change] of [
        ['NULL', 'uncleared'],
        ["cleared_at+interval '1 second'", 'postponed'],
        ["cleared_at-interval '1 second'", 'backdated'],
      ])
        await rejected(
          client,
          check(
            `cleared_at ${change}`,
            `UPDATE scim_membership_blocks SET cleared_at=${value} WHERE id='${block}'`,
          ),
        )
    }
    await transaction(source, verify)
    const clause = '(OLD.cleared_at IS NOT NULL AND NEW.cleared_at IS DISTINCT FROM OLD.cleared_at)'
    for (const replacement of [
      'false',
      // Only unclearing refused.
      '(OLD.cleared_at IS NOT NULL AND NEW.cleared_at IS NULL)',
      // Only unclearing and postponing refused: a clearance could be backdated.
      '(OLD.cleared_at IS NOT NULL AND (NEW.cleared_at IS NULL OR NEW.cleared_at > OLD.cleared_at))',
    ]) {
      const mutant = source.replace(clause, replacement)
      expect(mutant).not.toBe(source)
      await transaction(mutant, async (client) => {
        await expect(verify(client)).rejects.toMatchObject({ name: 'AssertionError' })
      })
    }
  })

  it('captured tombstones, live or cleared, cannot be deleted while their organization exists; disabling the guard fails', async () => {
    const live = check(
      'live tombstone delete',
      `DELETE FROM scim_membership_blocks WHERE id='${block}'`,
      tombstoneInsert(',id', `,'${block}'`),
    )
    const cleared = check(
      'cleared tombstone delete',
      `DELETE FROM scim_membership_blocks WHERE id='${id(17)}'`,
      tombstoneInsert(',id,cleared_at', `,'${id(17)}',now()`, 'suspension'),
    )
    const verify = async (client: pg.PoolClient) => {
      await rejected(client, live)
      await rejected(client, cleared)
      // An uncaptured blocker of a live account is not a tombstone yet.
      await client.query(blockInsert(',id', `,'${id(18)}'`))
      await succeeds(client, `DELETE FROM scim_membership_blocks WHERE id='${id(18)}'`)
    }
    await transaction(source, verify)
    for (const mutant of [
      source.replace(
        'IF OLD.identity_email IS NOT NULL AND\n       EXISTS (SELECT 1 FROM auth.organization WHERE id = OLD.organization_id) THEN',
        'IF false THEN',
      ),
      source.replace(
        'BEFORE UPDATE OR DELETE ON scim_membership_blocks',
        'BEFORE UPDATE ON scim_membership_blocks',
      ),
    ]) {
      expect(mutant).not.toBe(source)
      await transaction(mutant, async (client) => {
        await expect(verify(client)).rejects.toMatchObject({ name: 'AssertionError' })
      })
    }
  })

  it('a blocker detaches from its account only through account deletion; removing the check fails', async () => {
    const protection = check(
      'detach live account',
      `UPDATE scim_membership_blocks SET user_id=NULL WHERE id='${block}'`,
      blockInsert(',id,identity_email', `,'${block}','one@example.test'`, 'local', 'removal'),
    )
    const verify = async (client: pg.PoolClient) => {
      await rejected(client, protection)
      await succeeds(client, `DELETE FROM auth."user" WHERE id='${account}'`)
      expect(
        (
          await client.query(
            `SELECT user_id,identity_email FROM scim_membership_blocks WHERE id='${block}'`,
          )
        ).rows,
      ).toEqual([{ user_id: null, identity_email: 'one@example.test' }])
    }
    await transaction(source, verify)
    const mutant = source.replace(
      'IF OLD.user_id IS NOT NULL AND NEW.user_id IS NULL AND\n     EXISTS (SELECT 1 FROM auth."user" WHERE id = OLD.user_id) THEN',
      'IF false THEN',
    )
    expect(mutant).not.toBe(source)
    await transaction(mutant, async (client) => {
      await expect(verify(client)).rejects.toMatchObject({ name: 'AssertionError' })
    })
  })

  it('account deletion is never refused by an unstorable or duplicate tombstone mailbox; removing the tolerance fails', async () => {
    const verify = async (client: pg.PoolClient) => {
      // 321 normalized characters: longer than the tombstone bound.
      await client.query(accountInsert(id(61), "repeat('x',309)||'@example.test'"))
      await client.query(blockFor(id(61)))
      await client.query(
        blockFor(
          id(61),
          'suspension',
          ',connection_id,scim_user_id',
          `,'${connection}','${user}'`,
        ).replace("'local'", "'scim'"),
      )
      // Empty mailbox.
      await client.query(accountInsert(id(62), "''"))
      await client.query(blockFor(id(62)))
      // Mixed case and padding are normalized on capture.
      await client.query(accountInsert(id(63), "'  Mixed.Case@Example.TEST '"))
      await client.query(blockFor(id(63)))
      // The same decision already lives as a tombstone for this mailbox.
      await client.query(tombstoneInsert(',id', `,'${block}'`))
      await client.query(blockInsert('', '', 'local', 'removal'))
      await client.query(blockInsert(',cleared_at', ',now()', 'local', 'removal'))
      await client.query(blockInsert())
      // Exactly 320 normalized characters: the longest mailbox a tombstone can store.
      await client.query(accountInsert(id(66), "repeat('x',307)||'@example.test'"))
      await client.query(blockFor(id(66)))
      // Another team's live tombstone for the same mailbox must not swallow this team's
      // removal: deduplication is organization-local.
      await client.query(accountInsert(id(64), "'team-a@example.test'"))
      await client.query(blockFor(id(64)))
      await client.query(
        `INSERT INTO scim_membership_blocks (id,organization_id,user_id,identity_email,source,kind) VALUES ('${id(19)}','${otherOrg}',NULL,'team-a@example.test','local','removal')`,
      )
      // A live local tombstone must not swallow the SCIM authority's same-kind decision,
      // and both authorities' live tombstones coexist for one mailbox. The account's own
      // local removal duplicates the tombstone and is dropped.
      await client.query(accountInsert(id(65), "'both@example.test'"))
      await client.query(tombstoneInsert(',id', `,'${id(20)}'`, 'removal', 'both@example.test'))
      await client.query(blockFor(id(65)))
      await client.query(
        blockFor(
          id(65),
          'removal',
          ',connection_id,scim_user_id',
          `,'${connection}','${user}'`,
        ).replace("'local'", "'scim'"),
      )
      for (const deleted of [id(61), id(62), id(63), account, id(66), id(64), id(65)])
        await succeeds(client, `DELETE FROM auth."user" WHERE id='${deleted}'`)
      const row = (
        identity_email: string,
        kind: string,
        cleared = false,
        source = 'local',
        organization_id = org,
      ) => ({ organization_id, user_id: null, identity_email, source, kind, cleared })
      expect(
        (
          await client.query(
            `SELECT organization_id,user_id,identity_email,source,kind,cleared_at IS NOT NULL AS cleared FROM scim_membership_blocks ORDER BY organization_id,identity_email,source,kind,cleared`,
          )
        ).rows,
      ).toEqual([
        row('both@example.test', 'removal'),
        row('both@example.test', 'removal', false, 'scim'),
        row('mixed.case@example.test', 'removal'),
        row('one@example.test', 'removal'),
        row('one@example.test', 'removal', true),
        row('one@example.test', 'suspension'),
        row('team-a@example.test', 'removal'),
        row(`${'x'.repeat(307)}@example.test`, 'removal'),
        row('team-a@example.test', 'removal', false, 'local', otherOrg),
      ])
      expect(
        (
          await client.query(
            `SELECT id,connection_id,scim_user_id FROM scim_membership_blocks WHERE source='scim'`,
          )
        ).rows,
      ).toEqual([{ id: expect.any(String), connection_id: connection, scim_user_id: user }])
    }
    await transaction(source, verify)
    for (const mutant of [
      source.replace(
        'DELETE FROM scim_membership_blocks WHERE user_id = OLD.id AND identity_email IS NULL;\n',
        '',
      ),
      source.replace('IF char_length(mailbox) BETWEEN 1 AND 320 THEN', 'IF true THEN'),
      // Capture bound off by one: the 320-character mailbox is dropped.
      source.replace(
        'IF char_length(mailbox) BETWEEN 1 AND 320 THEN',
        'IF char_length(mailbox) BETWEEN 1 AND 319 THEN',
      ),
      source.replace(
        'b.identity_email IS NULL AND (b.cleared_at IS NOT NULL OR',
        'b.identity_email IS NULL AND (true OR',
      ),
      // Deduplication ignores the organization: another team's tombstone swallows a removal.
      source.replace(
        'WHERE t.organization_id = b.organization_id AND t.identity_email = mailbox AND',
        'WHERE t.identity_email = mailbox AND',
      ),
      // Deduplication ignores the authority: a local tombstone swallows the SCIM removal.
      source.replace(
        ' AND\n            t.source = b.source AND t.kind = b.kind AND t.cleared_at IS NULL));',
        ' AND\n            t.kind = b.kind AND t.cleared_at IS NULL));',
      ),
      // Live-identity index without the authority: the SCIM capture collides with the local
      // tombstone and the account deletion is refused with 23505.
      source.replace(
        '(organization_id, identity_email, source, kind)\n  WHERE cleared_at IS NULL;',
        '(organization_id, identity_email, kind)\n  WHERE cleared_at IS NULL;',
      ),
    ]) {
      expect(mutant).not.toBe(source)
      await transaction(mutant, async (client) => {
        await expect(verify(client)).rejects.toMatchObject({ name: 'AssertionError' })
      })
    }
  }, 60_000)

  it.each([
    ['scim_token_connections_connection_idx', 'organization_id, connection_id'],
    ['scim_users_member_idx', 'organization_id, linked_member_id, linked_user_id'],
    ['scim_users_account_idx', 'linked_user_id'],
    ['scim_users_manager_idx', 'organization_id, connection_id, manager_id'],
    ['scim_claims_user_idx', 'organization_id, connection_id, scim_user_id'],
    ['scim_claims_invitation_idx', 'organization_id, invitation_id'],
    ['scim_blocks_user_idx', 'user_id'],
    ['scim_blocks_resource_idx', 'organization_id, connection_id, scim_user_id'],
    ['scim_blocks_identity_idx', 'organization_id, identity_email'],
  ])('%s supports FK or tombstone lookup with its intended columns', async (name, columns) => {
    const verify = async (client: pg.PoolClient) => {
      const result = await client.query(
        "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname=$1",
        [name],
      )
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].indexdef).toContain(`(${columns})`)
    }
    await transaction(source, verify)
    const mutant = source.replace(new RegExp(`CREATE INDEX ${name}\\b[^;]+;`), '')
    expect(mutant).not.toBe(source)
    await transaction(mutant, async (client) => {
      await expect(verify(client)).rejects.toMatchObject({ name: 'AssertionError' })
    })
  })

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
      expect(
        (await client.query(`SELECT id FROM auth.member WHERE id='${otherMember}'`)).rows,
      ).toEqual([{ id: otherMember }])
    }
    await transaction(source, verify)
    for (const mutant of [
      source.replace(/CREATE TRIGGER scim_account_delete_links\b[^;]+;/, ''),
      source.replace('WHERE linked_user_id = OLD.id;', ';'),
      // Capture unscoped to every block in the instance.
      source.replace(
        'WHERE b.user_id = OLD.id AND b.identity_email IS NULL',
        'WHERE b.identity_email IS NULL',
      ),
      // Capture removed entirely: every blocker of the account is dropped.
      source.replace(
        / {2}IF char_length\(mailbox\) BETWEEN 1 AND 320 THEN[\s\S]*? {2}END IF;\n/,
        '',
      ),
      // Capture limited to live blockers: cleared history loses its identity and is dropped.
      source.replace(
        'WHERE b.user_id = OLD.id AND b.identity_email IS NULL',
        'WHERE b.user_id = OLD.id AND b.identity_email IS NULL AND b.cleared_at IS NULL',
      ),
      // Drop unscoped to every uncaptured block in the instance.
      source.replace(
        'DELETE FROM scim_membership_blocks WHERE user_id = OLD.id AND identity_email IS NULL;',
        'DELETE FROM scim_membership_blocks WHERE identity_email IS NULL;',
      ),
      source.replace(
        '\n  user_id uuid REFERENCES auth.user(id) ON DELETE SET NULL',
        '\n  user_id uuid REFERENCES auth.user(id) ON DELETE NO ACTION',
      ),
      source.replace(
        '\n  user_id uuid REFERENCES auth.user(id) ON DELETE SET NULL',
        '\n  user_id uuid REFERENCES auth.user(id) ON DELETE CASCADE',
      ),
    ]) {
      expect(mutant).not.toBe(source)
      await transaction(mutant, async (client) => {
        await expect(verify(client)).rejects.toMatchObject({ name: 'AssertionError' })
      })
    }
  })

  it('whole-organization deletion cascades its graph and removing the claim cleanup guard fails the success assertion', async () => {
    const verify = async (client: pg.PoolClient) => {
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
          (
            await client.query(
              `SELECT organization_id FROM ${table} WHERE organization_id='${org}'`,
            )
          ).rows,
        ).toEqual([])
      expect(
        (
          await client.query(
            `SELECT organization_id,scim_user_id,invitation_id FROM scim_user_claims`,
          )
        ).rows,
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
    await transaction(source, verify)
    for (const mutant of [
      source.replace(/CREATE TRIGGER scim_organization_delete_claims\b[^;]+;/, ''),
      source.replace(
        'DELETE FROM scim_user_claims WHERE organization_id = OLD.id;',
        'DELETE FROM scim_user_claims;',
      ),
    ]) {
      expect(mutant).not.toBe(source)
      await transaction(mutant, async (client) => {
        await expect(verify(client)).rejects.toMatchObject({ name: 'AssertionError' })
      })
    }
  })
  it('whole-organization deletion does not depend on FK cascade order; removing the binding cleanup fails under the adverse order', async () => {
    // PostgreSQL fires an organization's referential actions in RI trigger name order,
    // which follows object creation and can place the connection cascade before the token
    // cascade (CI reproduced this). Recreate the token cascade after 0073 to force that
    // order deterministically: the NO ACTION binding FK must then already be satisfied.
    const adverse = `${source}
      ALTER TABLE scim_provisioning_tokens DROP CONSTRAINT scim_provisioning_tokens_organization_id_fkey;
      ALTER TABLE scim_provisioning_tokens ADD CONSTRAINT scim_provisioning_tokens_organization_id_fkey
        FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;`
    const verify = async (client: pg.PoolClient) => {
      await succeeds(client, `DELETE FROM auth.organization WHERE id='${org}'`)
      expect(
        (
          await client.query(
            `SELECT count(*)::integer AS bindings FROM scim_token_connections WHERE organization_id='${org}'`,
          )
        ).rows,
      ).toEqual([{ bindings: 0 }])
      expect((await client.query(`SELECT token_id FROM scim_token_connections`)).rows).toEqual([
        { token_id: otherToken },
      ])
    }
    await transaction(adverse, verify)
    const mutant = adverse.replace(
      'DELETE FROM scim_token_connections WHERE organization_id = OLD.id;\n',
      '',
    )
    expect(mutant).not.toBe(adverse)
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
