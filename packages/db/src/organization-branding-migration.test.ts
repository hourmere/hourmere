import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0062_organization_branding.sql'
describe.skipIf(!serverUrl)('branding migration', () => {
  it('preserves populated predecessor organizations, membership and bookings; matches fresh and no-op rerun', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-brand-predecessor-'))
    let owned: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      for (const file of (await readdir(migrationsDir)).filter(
        (f) => f.endsWith('.sql') && f < migration,
      ))
        await copyFile(join(migrationsDir, file), join(directory, file))
      owned = await createTestDatabase(serverUrl as string, directory)
      const pool = owned.pool,
        org = randomUUID(),
        user = randomUUID(),
        event = randomUUID()
      await pool.query(
        `INSERT INTO auth."user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Brand owner','brand@example.test',true,'2024-01-01','2024-01-02');`,
        [user],
      )
      await pool.query(
        `INSERT INTO auth.organization (id,name,slug,"createdAt") VALUES ($1,'Brand team','brand-team','2024-01-01')`,
        [org],
      )
      await pool.query(
        `INSERT INTO auth.member ("organizationId","userId",role,"createdAt") VALUES ($1,$2,'owner','2024-01-01')`,
        [org, user],
      )
      await pool.query(
        `INSERT INTO event_types (id,organization_id,slug,title,duration_minutes) VALUES ($1,$2,'consult','Consultation',30)`,
        [event, org],
      )
      await pool.query(
        `INSERT INTO bookings (organization_id,event_type_id,start_at,end_at,title,source) VALUES ($1,$2,'2030-01-01T09:00Z','2030-01-01T09:30Z','Existing booking','web')`,
        [org, event],
      )
      const records = async () =>
        Promise.all(
          ['auth."user"', 'auth.organization', 'auth.member', 'event_types', 'bookings'].map(
            async (table) =>
              (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`)).rows,
          ),
        )
      const before = await records()
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(pool, directory)).toEqual([migration])
      expect(await records()).toEqual(before)
      expect((await pool.query('SELECT * FROM organization_branding')).rows).toEqual([])
      fresh = await createTestDatabase(serverUrl as string)
      expect(await snapshotSchema(pool)).toEqual(await snapshotSchema(fresh.pool))
      expect(await runMigrations(pool, directory)).toEqual([])
      expect(await records()).toEqual(before)
    } finally {
      await owned?.drop()
      await fresh?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
  it('kills copied SQL mutations of size, color, ownership and single-image constraints', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-brand-mutation-'))
    let owned: TestDatabase | undefined
    try {
      for (const file of (await readdir(migrationsDir)).filter(
        (f) => f.endsWith('.sql') && f < migration,
      ))
        await copyFile(join(migrationsDir, file), join(directory, file))
      owned = await createTestDatabase(serverUrl as string, directory)
      const client = await owned.pool.connect()
      try {
        const source = await readFile(join(migrationsDir, migration), 'utf8')
        const org = randomUUID(),
          other = randomUUID()
        await client.query(
          `INSERT INTO auth.organization (id,name,slug,"createdAt") VALUES ($1,'Team','brand-one',now()),($2,'Other','brand-two',now())`,
          [org, other],
        )
        const verify = async (sql: string, kind: string) => {
          await client.query('BEGIN')
          try {
            await client.query(sql)
            await client.query(
              'INSERT INTO organization_branding (organization_id) VALUES ($1),($2)',
              [org, other],
            )
            if (kind === 'native_boundary') {
              expect(
                (
                  await client.query(
                    "SELECT column_name FROM information_schema.columns WHERE table_schema='auth' AND table_name='organization' AND column_name IN ('brand_logo','brand_primary_color')",
                  )
                ).rows,
              ).toEqual([])
            }
            if (kind === 'color')
              await expect(
                client.query(
                  "UPDATE organization_branding SET brand_primary_color='red' WHERE organization_id=$1",
                  [org],
                ),
              ).rejects.toMatchObject({ code: '23514' })
            if (kind === 'size')
              await expect(
                client.query('INSERT INTO organization_brand_logos VALUES ($1,$2,$3)', [
                  org,
                  'a'.repeat(64),
                  Buffer.alloc(524289),
                ]),
              ).rejects.toMatchObject({ code: '23514' })
            if (kind === 'single') {
              await client.query('INSERT INTO organization_brand_logos VALUES ($1,$2,$3)', [
                org,
                'a'.repeat(64),
                Buffer.from('png'),
              ])
              await expect(
                client.query('INSERT INTO organization_brand_logos VALUES ($1,$2,$3)', [
                  org,
                  'b'.repeat(64),
                  Buffer.from('png'),
                ]),
              ).rejects.toMatchObject({ code: '23505' })
            }
            if (kind === 'ownership') {
              await client.query('INSERT INTO organization_brand_logos VALUES ($1,$2,$3)', [
                org,
                'a'.repeat(64),
                Buffer.from('png'),
              ])
              await client.query(
                'UPDATE organization_branding SET brand_logo=$2 WHERE organization_id=$1',
                [other, 'a'.repeat(64)],
              )
              await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toMatchObject({
                code: '23503',
              })
            }
          } finally {
            await client.query('ROLLBACK')
          }
        }
        for (const [kind, before, after] of [
          [
            'native_boundary',
            '-- Keep product settings outside',
            'ALTER TABLE auth.organization ADD COLUMN brand_logo text, ADD COLUMN brand_primary_color text;\n-- Keep product settings outside',
          ],
          ['color', "CHECK (brand_primary_color ~ '^#[0-9A-F]{6}$')", 'CHECK (true)'],
          ['single', 'organization_id uuid PRIMARY KEY', 'organization_id uuid NOT NULL'],
          ['size', 'CHECK (octet_length(data) BETWEEN 1 AND 524288)', 'CHECK (true)'],
          [
            'ownership',
            'FOREIGN KEY (organization_id, brand_logo)\n    REFERENCES organization_brand_logos(organization_id, hash) DEFERRABLE INITIALLY DEFERRED',
            'CHECK (true)',
          ],
        ] as const) {
          expect(source).toContain(before)
          await verify(source, kind)
          await expect(verify(source.replace(before, after), kind)).rejects.toMatchObject({
            name: 'AssertionError',
          })
          await verify(source, kind)
        }
      } finally {
        client.release()
      }
    } finally {
      await owned?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
