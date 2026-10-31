import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0046_current_inviter_signup.sql'
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

async function records(pool: pg.Pool) {
  const tables = (
    await pool.query<{ schema: string; name: string }>(`SELECT table_schema AS schema,
      table_name AS name FROM information_schema.tables
      WHERE table_schema IN ('auth','public') AND table_type='BASE TABLE'
      ORDER BY table_schema,table_name`)
  ).rows
  const result: Record<string, string[]> = {}
  for (const table of tables) {
    result[`${table.schema}.${table.name}`] = (
      await pool.query<{ row: string }>(`SELECT to_jsonb(r)::text AS row FROM
        (SELECT *,xmin::text AS _xmin,ctid::text AS _ctid
          FROM ${quote(table.schema)}.${quote(table.name)}) r
        ORDER BY to_jsonb(r)::text COLLATE "C"`)
    ).rows.map((row) => row.row)
  }
  return result
}

async function policy(client: pg.PoolClient) {
  await client.query('BEGIN')
  await client.query("SET LOCAL hourmere.signup = 'closed'")
  await client.query("SET LOCAL hourmere.signup_allowed_domains = 'corp.example'")
}

async function insert(client: pg.PoolClient, email: string) {
  return client.query(
    `INSERT INTO auth."user" (name,email,"emailVerified") VALUES ('Invitee',$1,true)`,
    [email],
  )
}

async function assertRefused(pool: pg.Pool, email: string) {
  const client = await pool.connect()
  try {
    await policy(client)
    await expect(
      insert(client, email),
      'a void invitation must not admit registration',
    ).rejects.toMatchObject({ code: '42501' })
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
  expect((await pool.query('SELECT id FROM auth."user" WHERE email=$1', [email])).rows).toEqual([])
}

async function seedAdmission(pool: pg.Pool) {
  const first = randomUUID()
  const inviter = randomUUID()
  const currentOwner = randomUUID()
  const team = randomUUID()
  const other = randomUUID()
  await pool.query(
    `INSERT INTO auth."user" (id,name,email,"emailVerified","createdAt") VALUES
      ($1,'First user','first@outside.example',true,'2020-01-01'),
      ($2,'Inviter','inviter@corp.example',true,'2021-01-01'),
      ($3,'Current owner','owner@corp.example',true,'2022-01-01');`,
    [first, inviter, currentOwner],
  )
  await pool.query(
    `INSERT INTO auth.organization (id,name,slug,"createdAt") VALUES
      ($1::uuid,'Team',$1::text,now()),($2::uuid,'Other team',$2::text,now())`,
    [team, other],
  )
  // Both inviters still belong to a different team; that cannot revive the old links.
  await pool.query(
    `INSERT INTO auth.member ("organizationId","userId",role,"createdAt") VALUES
      ($1,$2,'owner',now()),($1,$3,'member',now())`,
    [other, first, inviter],
  )
  await pool.query(
    `INSERT INTO auth.member ("organizationId","userId",role,"createdAt")
      VALUES ($1,$2,'owner',now())`,
    [team, currentOwner],
  )
  await pool.query(
    `INSERT INTO auth.invitation ("organizationId","inviterId",email,role,status,"expiresAt")
      VALUES ($1,$2,'departed-domain@outside.example','member','pending',now()+interval '1 day'),
        ($1,$3,'departed-first@outside.example','member','pending',now()+interval '1 day')`,
    [team, inviter, first],
  )
  return { first, inviter, team }
}

async function assertMemberLock(pool: pg.Pool, inviter: string, team: string) {
  await pool.query(
    `INSERT INTO auth.member ("organizationId","userId",role,"createdAt")
      VALUES ($1,$2,'member',now())`,
    [team, inviter],
  )
  const signup = await pool.connect()
  const departure = await pool.connect()
  let deletion: Promise<pg.QueryResult> | undefined
  let done = false
  try {
    await policy(signup)
    await insert(signup, 'departed-domain@outside.example')
    const signupPid = (await signup.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0]?.pid
    const departurePid = (await departure.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0]?.pid
    deletion = departure
      .query('DELETE FROM auth.member WHERE "organizationId"=$1 AND "userId"=$2', [team, inviter])
      .finally(() => {
        done = true
      })
    const blocked = async () =>
      (
        await pool.query<{ blocked: boolean }>('SELECT $1 = ANY(pg_blocking_pids($2)) AS blocked', [
          signupPid,
          departurePid,
        ])
      ).rows[0]?.blocked === true
    await expect.poll(async () => done || (await blocked()), { timeout: 5_000 }).toBe(true)
    expect(await blocked(), 'signup must hold the inviter member row until commit').toBe(true)
    expect(done).toBe(false)
  } finally {
    await signup.query('ROLLBACK')
    await deletion
    signup.release()
    departure.release()
    await pool.query('DELETE FROM auth.member WHERE "organizationId"=$1 AND "userId"=$2', [
      team,
      inviter,
    ])
  }
}

describe.skipIf(!serverUrl)('current inviter signup migration', () => {
  it('preserves populated 0045 data, matches fresh installation and reruns without writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-current-inviter-upgrade-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = (await readdir(migrationsDir)).filter(
        (file) => file.endsWith('.sql') && file < migration,
      )
      for (const file of files.filter((file) => file.slice(0, 4) <= '0012'))
        await copyFile(join(migrationsDir, file), join(directory, file))
      upgraded = await createTestDatabase(serverUrl as string, directory, { tag: 'signup_old' })
      await seedEarly(upgraded.pool)
      for (const file of files.filter((file) => file.slice(0, 4) > '0012'))
        await copyFile(join(migrationsDir, file), join(directory, file))
      await runMigrations(upgraded.pool, directory)
      await seedLater(upgraded.pool)
      await seedAdmission(upgraded.pool)
      const before = await records(upgraded.pool)
      expect(before['public.bookings']).toHaveLength(8)
      expect(before['public.sign_in_emails']).toHaveLength(2)
      expect(
        (await upgraded.pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.at(-1),
      ).toEqual({ name: '0045_invitation_generation_actor.sql' })
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([migration])
      const after = await records(upgraded.pool)
      const { 'public.schema_migrations': _oldLedger, ...oldData } = before
      const { 'public.schema_migrations': _newLedger, ...newData } = after
      expect(newData).toEqual(oldData)
      await assertRefused(upgraded.pool, 'departed-domain@outside.example')
      await assertRefused(upgraded.pool, 'departed-first@outside.example')
      const schema = await snapshotSchema(upgraded.pool)
      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'signup_fresh' })
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      expect(await records(upgraded.pool)).toEqual(after)
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
    } finally {
      try {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }, 60_000)

  it.each(['membership', 'same team', 'original inviter', 'member lock'] as const)(
    'detects a source-copy mutation of %s and verifies the restored trigger',
    async (protection) => {
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-current-inviter-mutation-'))
      let owned: TestDatabase | undefined
      try {
        const source = await readFile(join(migrationsDir, migration), 'utf8')
        const path = join(directory, migration)
        await copyFile(join(migrationsDir, migration), path)
        owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'signup_mutant' })
        const { inviter, team } = await seedAdmission(owned.pool)
        const check = () =>
          protection === 'member lock'
            ? assertMemberLock(owned?.pool as pg.Pool, inviter, team)
            : assertRefused(owned?.pool as pg.Pool, 'departed-domain@outside.example')
        await check()
        const mutant =
          protection === 'membership'
            ? source
                .replace(
                  'JOIN auth.member m ON m."userId" = i."inviterId"\n        AND m."organizationId" = i."organizationId"',
                  '',
                )
                .replace('FOR SHARE OF i, inviter, m;', 'FOR SHARE OF i, inviter;')
            : protection === 'same team'
              ? source.replace('AND m."organizationId" = i."organizationId"', '')
              : protection === 'original inviter'
                ? source.replace('m."userId" = i."inviterId"', 'true')
                : source.replace('FOR SHARE OF i, inviter, m;', 'FOR SHARE OF i, inviter;')
        expect(mutant).not.toBe(source)
        await writeFile(path, mutant)
        await owned.pool.query(await readFile(path, 'utf8'))
        await expect(check()).rejects.toMatchObject({ name: 'AssertionError' })
        await writeFile(path, source)
        await owned.pool.query(await readFile(path, 'utf8'))
        await check()
        expect(owned.pool.totalCount).toBeLessThanOrEqual(3)
      } finally {
        try {
          await owned?.drop()
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      }
    },
    30_000,
  )
})
