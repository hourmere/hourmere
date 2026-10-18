import { randomBytes } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPool } from './index.ts'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0027_nontransitive_invited_signup.sql'

describe.skipIf(!serverUrl)('non-transitive invitation migration', () => {
  const name = `hourmere_test_${process.pid}_${randomBytes(4).toString('hex')}`
  let pool: pg.Pool
  let predecessor: string

  beforeAll(async () => {
    const admin = createPool(serverUrl as string)
    try {
      await admin.query(`CREATE DATABASE ${name}`)
    } finally {
      await admin.end()
    }
    const url = new URL(serverUrl as string)
    url.pathname = `/${name}`
    pool = createPool(url.toString())
    predecessor = await mkdtemp(join(tmpdir(), 'hourmere-signup-predecessor-'))
    for (const file of await readdir(migrationsDir)) {
      if (file.endsWith('.sql') && file < migration) {
        await copyFile(join(migrationsDir, file), join(predecessor, file))
      }
    }
    await runMigrations(pool, predecessor)
  })

  afterAll(async () => {
    await pool?.end()
    const admin = createPool(serverUrl as string)
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    } finally {
      await admin.end()
      if (predecessor) await rm(predecessor, { recursive: true, force: true })
    }
  })

  it('preserves populated predecessor data, changes admission and is a no-op on rerun', async () => {
    const first = '00000000-0000-4000-8000-000000000001'
    const inviter = '00000000-0000-4000-8000-000000000002'
    const guest = '00000000-0000-4000-8000-000000000003'
    const team = '00000000-0000-4000-8000-000000000004'
    const personal = '00000000-0000-4000-8000-000000000005'
    await pool.query(
      `INSERT INTO auth."user" (id, name, email, "emailVerified", "createdAt") VALUES
         ($1, 'Owner', 'owner@outside.example', true, '2026-01-01'),
         ($2, 'Allowed colleague', 'colleague@team.example', true, '2026-01-02'),
         ($3, 'Invited guest', 'guest@outside.example', true, '2026-01-03')`,
      [first, inviter, guest],
    )
    await pool.query(
      `INSERT INTO auth.organization (id, name, slug, "createdAt") VALUES
         ($1, 'Existing team', 'existing-team', '2026-01-02'),
         ($2, 'Guest personal', 'guest-personal', '2026-01-03')`,
      [team, personal],
    )
    await pool.query(
      `INSERT INTO auth.member ("organizationId", "userId", role, "createdAt") VALUES
         ($1, $2, 'owner', now()), ($1, $3, 'member', now()), ($4, $3, 'owner', now())`,
      [team, inviter, guest, personal],
    )
    await pool.query(
      'INSERT INTO personal_organizations (user_id, organization_id) VALUES ($1, $2)',
      [guest, personal],
    )
    await pool.query(
      `INSERT INTO auth.invitation ("organizationId", "inviterId", email, role, status, "expiresAt") VALUES
         ($1, $2, 'next@outside.example', 'member', 'pending', now() + interval '1 day'),
         ($1, $3, 'already@outside.example', 'member', 'accepted', now() + interval '1 day'),
         ($1, $3, 'expired@outside.example', 'member', 'pending', now() - interval '1 day')`,
      [team, guest, inviter],
    )
    const snapshot = async () => {
      const tables = [
        'auth."user"',
        'auth.organization',
        'auth.member',
        'auth.invitation',
        'personal_organizations',
      ]
      return Promise.all(
        tables.map(async (table) => (await pool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows),
      )
    }
    const before = await snapshot()
    await copyFile(join(migrationsDir, migration), join(predecessor, migration))
    expect(await runMigrations(pool, predecessor)).toEqual([migration])
    expect(await snapshot()).toEqual(before)
    expect(await runMigrations(pool, predecessor)).toEqual([])
    expect(await snapshot()).toEqual(before)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL hourmere.signup = 'closed'")
      await client.query("SET LOCAL hourmere.signup_allowed_domains = 'team.example'")
      await expect(
        client.query(
          `INSERT INTO auth."user" (name, email, "emailVerified") VALUES ('Next', 'next@outside.example', true)`,
        ),
      ).rejects.toMatchObject({ code: '42501' })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('installs on a fresh database and records no work on a second run', async () => {
    const fresh = await createTestDatabase(serverUrl as string)
    try {
      expect(
        (await fresh.pool.query('SELECT name FROM schema_migrations WHERE name = $1', [migration]))
          .rows,
      ).toEqual([{ name: migration }])
      expect(await runMigrations(fresh.pool)).toEqual([])
    } finally {
      await fresh.drop()
    }
  })
})
