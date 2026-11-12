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
const migration = '0073_scim_identity.sql'

async function records(pool: pg.Pool, tables?: { schema: string; name: string }[]) {
  const selected =
    tables ??
    (
      await pool.query<{ schema: string; name: string }>(
        `SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
     WHERE table_schema IN ('auth','public') AND table_type='BASE TABLE'
     AND table_name <> 'schema_migrations' ORDER BY table_schema,table_name`,
      )
    ).rows
  const data: Record<string, unknown> = {}
  for (const table of selected) {
    data[`${table.schema}.${table.name}`] = (
      await pool.query(
        `SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS fingerprint,
       xmin::text,ctid::text FROM "${table.schema}"."${table.name}" t ORDER BY fingerprint`,
      )
    ).rows
  }
  return { tables: selected, data }
}

async function predecessor() {
  const directory = await mkdtemp(join(tmpdir(), 'hourmere-scim-identity-predecessor-'))
  const early = await mkdtemp(join(tmpdir(), 'hourmere-scim-identity-early-'))
  let database: TestDatabase | undefined
  try {
    // Every predecessor migration, including out-of-order numbers merged on main.
    for (const file of (await readdir(migrationsDir)).filter(
      (f) => f.endsWith('.sql') && f !== migration,
    )) {
      await copyFile(join(migrationsDir, file), join(directory, file))
      if (file.slice(0, 4) <= '0012') await copyFile(join(migrationsDir, file), join(early, file))
    }
    database = await createTestDatabase(serverUrl as string, early)
    await seedEarly(database.pool)
    await runMigrations(database.pool, directory)
    await seedLater(database.pool)
    await database.pool.query(`
      INSERT INTO auth.organization (name,slug,"createdAt")
        VALUES ('Second upgrade team','upgrade-scim-team',now());
      INSERT INTO scim_provisioning_tokens
        (organization_id,name,token_hash,previous_token_hash,previous_valid_until,
         created_by_user_id,rotated_by_user_id,rotated_at,last_used_at,revoked_at,created_at)
      SELECT o.id, 'Synthetic ' || states.n,
        CASE WHEN states.n <> 3 THEN substr(encode(sha256(convert_to(o.id::text || states.n::text,'UTF8')),'hex'),1,43) END,
        CASE WHEN states.n = 2 THEN substr(encode(sha256(convert_to(o.id::text || 'previous','UTF8')),'hex'),1,43) END,
        CASE WHEN states.n = 2 THEN '2030-01-02T03:04:05.123456Z'::timestamptz END,
        u.id, CASE WHEN states.n = 2 THEN u.id END,
        CASE WHEN states.n = 2 THEN '2026-01-02T03:04:05.123456Z'::timestamptz END,
        '2026-02-03T04:05:06.654321Z',
        CASE WHEN states.n = 3 THEN '2026-03-04T05:06:07.123456Z'::timestamptz END,
        '2026-01-01T01:02:03.123456Z'
      FROM auth.organization o CROSS JOIN generate_series(1,3) states(n)
      CROSS JOIN LATERAL (SELECT id FROM auth."user" ORDER BY id LIMIT 1) u
      WHERE o.slug IN ('upgrade-team','upgrade-scim-team');
    `)
    return { directory, database }
  } catch (error) {
    await database?.drop()
    await rm(directory, { recursive: true, force: true })
    throw error
  } finally {
    await rm(early, { recursive: true, force: true })
  }
}

describe.skipIf(!serverUrl)('SCIM identity migration', () => {
  it('preserves every predecessor record including active, overlapping and revoked credentials; equals fresh and reruns without writes', async () => {
    const { directory, database } = await predecessor()
    let fresh: TestDatabase | undefined
    try {
      const before = await records(database.pool)
      expect((before.data['public.scim_provisioning_tokens'] as unknown[]).length).toBe(6)
      expect((before.data['public.bookings'] as unknown[]).length).toBeGreaterThan(0)
      expect((before.data['auth.member'] as unknown[]).length).toBeGreaterThan(0)
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(database.pool, directory)).toEqual([migration])
      expect((await records(database.pool, before.tables)).data).toEqual(before.data)
      expect(
        (
          await database.pool.query(
            `SELECT count(*)::integer AS count,count(DISTINCT connection_id)::integer AS connections FROM scim_token_connections`,
          )
        ).rows,
      ).toEqual([{ count: 6, connections: 2 }])
      expect(
        (
          await database.pool.query(
            `SELECT count(*)::integer AS count FROM scim_token_connections b JOIN scim_provisioning_tokens t ON t.id=b.token_id JOIN scim_connections c ON c.id=b.connection_id WHERE b.organization_id=t.organization_id AND c.organization_id=t.organization_id`,
          )
        ).rows,
      ).toEqual([{ count: 6 }])
      expect(
        (
          await database.pool.query(
            `SELECT o.slug,count(DISTINCT c.id)::integer AS connections,
              count(b.token_id)::integer AS bindings
             FROM auth.organization o JOIN scim_connections c ON c.organization_id=o.id
             JOIN scim_token_connections b ON b.connection_id=c.id
             GROUP BY o.slug ORDER BY o.slug`,
          )
        ).rows,
      ).toEqual([
        { slug: 'upgrade-scim-team', connections: 1, bindings: 3 },
        { slug: 'upgrade-team', connections: 1, bindings: 3 },
      ])
      const upgraded = await records(database.pool)
      expect(await runMigrations(database.pool, directory)).toEqual([])
      expect(await records(database.pool)).toEqual(upgraded)
      fresh = await createTestDatabase(serverUrl as string)
      expect(await snapshotSchema(database.pool)).toEqual(await snapshotSchema(fresh.pool))
    } finally {
      await fresh?.drop()
      await database.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('blocks concurrent token creation before the connection snapshot, including a removed-lock control', async () => {
    const source = await readFile(join(migrationsDir, migration), 'utf8')
    for (const mutated of [true, false]) {
      const { directory, database } = await predecessor()
      const migrator = await database.pool.connect()
      const writer = await database.pool.connect()
      try {
        const organization = (
          await writer.query(`INSERT INTO auth.organization (name,slug,"createdAt")
            VALUES ('Concurrent team','concurrent-team',now()) RETURNING id`)
        ).rows[0].id
        const sql = mutated
          ? source.replace('LOCK TABLE scim_provisioning_tokens IN ACCESS EXCLUSIVE MODE;', '')
          : source
        const boundary = sql.indexOf('INSERT INTO scim_connections (organization_id)')
        expect(boundary).toBeGreaterThan(0)
        await migrator.query('BEGIN')
        await migrator.query(sql.slice(0, boundary))
        await writer.query("BEGIN; SET LOCAL lock_timeout = '150ms'")
        const insert = () =>
          writer.query(
            `INSERT INTO scim_provisioning_tokens (organization_id,name,token_hash)
            VALUES ($1,'Concurrent token',repeat('z',43))`,
            [organization],
          )
        const verify = async () => {
          await expect(insert()).rejects.toMatchObject({ code: '55P03' })
        }
        if (mutated) await expect(verify()).rejects.toMatchObject({ name: 'AssertionError' })
        else await verify()
        await writer.query('ROLLBACK')
        await migrator.query(sql.slice(boundary))
        await migrator.query('COMMIT')
        await insert()
        expect(
          (
            await writer.query(
              `SELECT count(*)::integer AS count FROM scim_token_connections
            WHERE organization_id=$1`,
              [organization],
            )
          ).rows,
        ).toEqual([{ count: 1 }])
      } finally {
        await writer.query('ROLLBACK')
        await migrator.query('ROLLBACK')
        writer.release()
        migrator.release()
        await database.drop()
        await rm(directory, { recursive: true, force: true })
      }
    }
  }, 30_000)

  // Concurrent writer shapes from packages/auth and docs/data-model.md, each run against
  // the real migration with lock probes (pg_blocking_pids) instead of sleeps:
  //   B  token administration that already counted tokens (access share) before inserting;
  //   C  token administration holding user → organization → member locks before counting;
  //   C2 the same writer that has locked the organization row but not yet its member row;
  //   A2 the first token of an organization without one, under the same locks;
  //   A3 a bare member share lock without an organization lock, then counting;
  //   D  team creation inserting an organization and then its owner membership;
  //   E  sign-up inserting an account, then its organization and membership.
  // Each must commit on both sides, serialized by the migration's locks, without 40P01.
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const tokenOrg = uuid(1),
    freshOrg = uuid(2),
    tokenMember = uuid(3),
    freshMember = uuid(4),
    createdOrg = uuid(5),
    createdMember = uuid(6),
    signedUpUser = uuid(7),
    signedUpOrg = uuid(8),
    signedUpMember = uuid(9),
    actor = uuid(10)
  const countTokens = (organization: string) =>
    `SELECT count(*) FROM scim_provisioning_tokens WHERE organization_id='${organization}' AND revoked_at IS NULL`
  const insertToken = (organization: string) =>
    `INSERT INTO scim_provisioning_tokens (organization_id,name,token_hash) VALUES ('${organization}','Concurrent',repeat('z',43))`
  const actorLocks = (organization: string, memberRow?: string) => [
    `SELECT id FROM auth."user" WHERE id='${actor}' FOR SHARE`,
    `SELECT id FROM auth.organization WHERE id='${organization}' FOR UPDATE`,
    ...(memberRow ? [`SELECT id FROM auth.member WHERE id='${memberRow}' FOR SHARE`] : []),
  ]
  interface Writer {
    name: string
    before: string[]
    after: string[]
    /** Which side the other one's locks hold back once the migration has started. */
    blocked: 'migrator' | 'writer'
    tokens: boolean
  }
  const writers: Writer[] = [
    {
      name: 'B',
      before: [countTokens(tokenOrg)],
      after: [insertToken(tokenOrg)],
      blocked: 'migrator',
      tokens: true,
    },
    {
      name: 'C',
      before: actorLocks(tokenOrg, tokenMember),
      after: [countTokens(tokenOrg), insertToken(tokenOrg)],
      blocked: 'migrator',
      tokens: true,
    },
    {
      name: 'C2',
      before: actorLocks(tokenOrg),
      after: [
        `SELECT id FROM auth.member WHERE id='${tokenMember}' FOR SHARE`,
        countTokens(tokenOrg),
        insertToken(tokenOrg),
      ],
      blocked: 'writer',
      tokens: true,
    },
    {
      name: 'A2',
      before: actorLocks(freshOrg, freshMember),
      after: [countTokens(freshOrg), insertToken(freshOrg)],
      blocked: 'migrator',
      tokens: true,
    },
    {
      name: 'A3',
      before: [`SELECT id FROM auth.member WHERE id='${tokenMember}' FOR SHARE`],
      after: [countTokens(tokenOrg), insertToken(tokenOrg)],
      blocked: 'migrator',
      tokens: true,
    },
    {
      name: 'D',
      before: [
        `INSERT INTO auth.organization (id,name,slug,"createdAt") VALUES ('${createdOrg}','Created team','created-team',now())`,
      ],
      after: [
        `INSERT INTO auth.member (id,"organizationId","userId",role,"createdAt") VALUES ('${createdMember}','${createdOrg}','${actor}','owner',now())`,
      ],
      blocked: 'migrator',
      tokens: false,
    },
    {
      name: 'E',
      before: [
        `INSERT INTO auth."user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('${signedUpUser}','Signed up','signed-up@example.test',true,now(),now())`,
      ],
      after: [
        `INSERT INTO auth.organization (id,name,slug,"createdAt") VALUES ('${signedUpOrg}','Signed-up team','signed-up-team',now())`,
        `INSERT INTO auth.member (id,"organizationId","userId",role,"createdAt") VALUES ('${signedUpMember}','${signedUpOrg}','${signedUpUser}','owner',now())`,
      ],
      blocked: 'migrator',
      tokens: false,
    },
  ]

  async function untilBlocked(probe: pg.PoolClient, waiting: number, holder: number) {
    const deadline = Date.now() + 15_000
    for (;;) {
      const { rows } = await probe.query<{ blocked: boolean }>(
        'SELECT $1 = ANY(pg_blocking_pids($2)) AS blocked',
        [holder, waiting],
      )
      if (rows[0]?.blocked) return
      if (Date.now() > deadline) throw new Error('lock probe: expected wait never started')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  async function raceMigration(sql: string, writer: Writer) {
    const { directory, database } = await predecessor()
    const migrator = await database.pool.connect()
    const client = await database.pool.connect()
    const probe = await database.pool.connect()
    try {
      await database.pool.query(`
        INSERT INTO auth.organization (id,name,slug,"createdAt") VALUES
          ('${tokenOrg}','Token team','token-team',now()),('${freshOrg}','Fresh team','fresh-team',now());
        INSERT INTO auth."user" (id,name,email,"emailVerified","createdAt","updatedAt")
          VALUES ('${actor}','Actor','actor@example.test',true,now(),now());
        INSERT INTO auth.member (id,"organizationId","userId",role,"createdAt") VALUES
          ('${tokenMember}','${tokenOrg}','${actor}','owner',now()),('${freshMember}','${freshOrg}','${actor}','owner',now());
        INSERT INTO scim_provisioning_tokens (organization_id,name,token_hash) VALUES ('${tokenOrg}','Existing',repeat('a',43));`)
      const pid = async (c: pg.PoolClient) =>
        (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid as number
      const [migratorPid, writerPid] = [await pid(migrator), await pid(client)]
      const boundary = sql.indexOf('INSERT INTO scim_connections (organization_id)')
      expect(boundary).toBeGreaterThan(0)
      await client.query('BEGIN')
      for (const statement of writer.before) await client.query(statement)
      await migrator.query('BEGIN')
      const head = migrator.query(sql.slice(0, boundary))
      head.catch(() => {})
      const finishWriter = async () => {
        for (const statement of writer.after) await client.query(statement)
        await client.query('COMMIT')
      }
      const finishMigrator = async () => {
        await head
        await migrator.query(sql.slice(boundary))
        await migrator.query('COMMIT')
      }
      let outcomes: PromiseSettledResult<void>[]
      if (writer.blocked === 'migrator') {
        // A mutant that no longer waits here lets the head finish; the race then plays out below.
        await Promise.race([untilBlocked(probe, migratorPid, writerPid), head])
        outcomes = await Promise.allSettled([finishWriter(), finishMigrator()])
      } else {
        await head
        const pending = finishWriter()
        pending.catch(() => {})
        await untilBlocked(probe, writerPid, migratorPid)
        outcomes = await Promise.allSettled([pending, finishMigrator()])
      }
      const failure = outcomes.find((outcome) => outcome.status === 'rejected')
      if (failure) throw failure.reason
      if (writer.tokens) {
        expect(
          (
            await probe.query(
              `SELECT count(*)::integer AS total, count(*) FILTER (WHERE b.token_id IS NULL)::integer AS unbound
               FROM scim_provisioning_tokens t LEFT JOIN scim_token_connections b ON b.token_id=t.id`,
            )
          ).rows,
        ).toEqual([{ total: 8, unbound: 0 }])
      } else {
        expect(
          (
            await probe.query(
              `SELECT count(*)::integer AS members FROM auth.member WHERE id IN ('${createdMember}','${signedUpMember}')`,
            )
          ).rows,
        ).toEqual([{ members: 1 }])
        expect(
          (
            await probe.query(
              "SELECT to_regclass('scim_membership_blocks') IS NOT NULL AS migrated",
            )
          ).rows,
        ).toEqual([{ migrated: true }])
      }
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      await migrator.query('ROLLBACK').catch(() => {})
      client.release()
      migrator.release()
      probe.release()
      await database.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }

  it.each(writers)(
    'writer shape $name commits alongside the migration without a deadlock',
    async (writer) => {
      const source = await readFile(join(migrationsDir, migration), 'utf8')
      await raceMigration(source, writer)
    },
    60_000,
  )

  const organizationFk =
    'ALTER TABLE scim_connections ADD CONSTRAINT scim_connections_organization_id_fkey\n  FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;\n'
  it.each([
    {
      name: 'token lock weakened to SHARE ROW EXCLUSIVE (upgrade needed later)',
      shape: 'B',
      mutate: (source: string) =>
        source.replace(
          'LOCK TABLE scim_provisioning_tokens IN ACCESS EXCLUSIVE MODE;',
          'LOCK TABLE scim_provisioning_tokens IN SHARE ROW EXCLUSIVE MODE;',
        ),
    },
    {
      name: 'member and invitation lock removed (taken after the token lock instead)',
      shape: 'A3',
      mutate: (source: string) =>
        source.replace('LOCK TABLE auth.member, auth.invitation IN ACCESS EXCLUSIVE MODE;\n', ''),
    },
    {
      name: 'member and invitation lock removed, against the token administration shape',
      shape: 'C',
      mutate: (source: string) =>
        source.replace('LOCK TABLE auth.member, auth.invitation IN ACCESS EXCLUSIVE MODE;\n', ''),
    },
    {
      name: 'organization lock removed (taken after the member lock instead)',
      shape: 'D',
      mutate: (source: string) =>
        source.replace('LOCK TABLE auth.organization IN SHARE ROW EXCLUSIVE MODE;\n', ''),
    },
    {
      name: 'account lock removed (taken after the organization lock instead)',
      shape: 'E',
      mutate: (source: string) =>
        source.replace('LOCK TABLE auth."user" IN SHARE ROW EXCLUSIVE MODE;\n', ''),
    },
    {
      name: 'organization FK present during the backfill (organization row locks)',
      shape: 'C2',
      mutate: (source: string) =>
        source
          .replace(organizationFk, '')
          .replace(
            'INSERT INTO scim_connections (organization_id)\nSELECT DISTINCT',
            `${organizationFk}INSERT INTO scim_connections (organization_id)\nSELECT DISTINCT`,
          ),
    },
  ])(
    'lock-order mutation "$name" deadlocks writer shape $shape',
    async (entry) => {
      const source = await readFile(join(migrationsDir, migration), 'utf8')
      const mutant = entry.mutate(source)
      expect(mutant).not.toBe(source)
      const writer = writers.find((w) => w.name === entry.shape) as Writer
      await expect(raceMigration(mutant, writer)).rejects.toMatchObject({ code: '40P01' })
    },
    60_000,
  )

  // The bound must precede every lock the migration takes. The lock set is derived from
  // the migration source, so a lock added later needs a case here before the test passes.
  // The derivation is total: with whole-line comments removed, every LOCK keyword must
  // belong to a one-line `LOCK TABLE … IN … MODE;` statement. A lock in any other form
  // PostgreSQL accepts (without TABLE, in the default mode, across lines, in other case,
  // with a trailing comment) fails here instead of escaping the per-table cases. As in
  // PostgreSQL, a `--` comment ends at a line feed or a carriage return, so text after a
  // lone carriage return is code.
  const code = (sql: string) => sql.replace(/^[ \t]*--[^\n\r]*/gm, '')
  function lockedTables(sql: string): string[] {
    const statements = [...code(sql).matchAll(/^LOCK TABLE (.+) IN [A-Z ]+ MODE;$/gm)]
    expect(
      code(sql).match(/\block\b/gi)?.length ?? 0,
      'every LOCK statement is a one-line LOCK TABLE … IN … MODE;',
    ).toBe(statements.length)
    return statements.flatMap((match) =>
      (match[1] as string).split(',').map((table) => table.trim()),
    )
  }
  const firstStatement = (sql: string) =>
    code(sql)
      .split(';')
      .map((statement) => statement.replace(/\s+/g, ' ').trim())
      .find(Boolean)
  const boundStatement = "SET LOCAL lock_timeout = '5s'"
  const bound = `${boundStatement};\n`
  // Move the bound below the statement that locks `table`: that wait and every earlier
  // one become unbounded again.
  const boundAfter = (table: string) => (source: string) => {
    const statement = `${source
      .split('\n')
      .find((line) => line.startsWith('LOCK TABLE ') && line.includes(table))}\n`
    return source.replace(bound, '').replace(statement, `${statement}${bound}`)
  }

  async function heldLockFailsFast(
    database: TestDatabase,
    directory: string,
    table: string,
  ): Promise<void> {
    // An in-flight write holds ROW EXCLUSIVE on its table for as long as its transaction
    // lives; every lock mode the migration takes conflicts with it.
    const holder = await database.pool.connect()
    let attempt: Promise<string[]> = Promise.resolve([])
    try {
      await holder.query('BEGIN')
      await holder.query(`LOCK TABLE ${table} IN ROW EXCLUSIVE MODE`)
      const started = Date.now()
      attempt = runMigrations(database.pool, directory)
      attempt.catch(() => {})
      let timer: ReturnType<typeof setTimeout> | undefined
      const outcome = await Promise.race([
        attempt.then(
          () => 'applied',
          (error: unknown) =>
            `failed ${(error as { cause?: { code?: string } }).cause?.code ?? 'without a code'}`,
        ),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('still waiting'), 10_000)
        }),
      ])
      clearTimeout(timer)
      const elapsed = Date.now() - started
      expect({ table, outcome }).toEqual({ table, outcome: 'failed 55P03' })
      expect(elapsed, `${table} wait`).toBeLessThan(10_000)
      expect(
        (await database.pool.query('SELECT name FROM schema_migrations WHERE name=$1', [migration]))
          .rows,
      ).toEqual([])
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
      // Under a mutant the attempt is still waiting; it finishes once the holder is gone.
      await attempt.catch(() => {})
    }
  }

  // Nothing runs before the bound, so no explicit LOCK and no implicit lock taken by DDL can
  // wait unbounded, and nothing later in the file changes it.
  it('sets the lock-wait bound as the first statement and sets lock_timeout nowhere else', async () => {
    const source = await readFile(join(migrationsDir, migration), 'utf8')
    expect(firstStatement(source)).toBe(boundStatement)
    expect(code(source).match(/\block_timeout\b/gi)?.length ?? 0).toBe(1)
  })

  it.each([
    { form: 'without TABLE', lock: 'LOCK auth.session IN SHARE MODE;\n' },
    { form: 'across two lines', lock: 'LOCK TABLE auth.session\n  IN SHARE MODE;\n' },
    {
      form: 'after a comment ended by a lone carriage return',
      lock: '-- ended by a carriage return\rLOCK auth.session IN SHARE MODE;\n',
    },
  ])(
    'lock-form control: a lock $form before the bound fails the derivation and the bound check',
    async ({ lock }) => {
      const source = await readFile(join(migrationsDir, migration), 'utf8')
      const mutant = source.replace(bound, `${lock}${bound}`)
      expect(mutant).not.toBe(source)
      expect(() => lockedTables(source)).not.toThrow()
      expect(firstStatement(source)).toBe(boundStatement)
      expect(() => lockedTables(mutant)).toThrow('every LOCK statement is a one-line')
      expect(firstStatement(mutant)).not.toBe(boundStatement)
    },
  )

  it('bounds every lock wait: each table the migration locks, held by a writer, fails it with 55P03 within 10 s and records nothing, and the next start applies it', async () => {
    const source = await readFile(join(migrationsDir, migration), 'utf8')
    const tables = lockedTables(source)
    expect(tables).toEqual([
      'auth."user"',
      'auth.organization',
      'auth.member',
      'auth.invitation',
      'scim_provisioning_tokens',
    ])
    const { directory, database } = await predecessor()
    try {
      await writeFile(join(directory, migration), source)
      // Every attempt rolls back, so one predecessor database serves every held lock.
      for (const table of tables) await heldLockFailsFast(database, directory, table)
      expect(await runMigrations(database.pool, directory)).toEqual([migration])
    } finally {
      await database.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)

  it.each([
    {
      name: 'bound removed',
      table: 'auth."user"',
      mutate: (source: string) => source.replace(bound, ''),
    },
    {
      name: 'bound set after the account lock',
      table: 'auth."user"',
      mutate: boundAfter('auth."user"'),
    },
    {
      name: 'bound set after the organization lock',
      table: 'auth.organization',
      mutate: boundAfter('auth.organization'),
    },
    {
      name: 'bound set after the member and invitation lock',
      table: 'auth.invitation',
      mutate: boundAfter('auth.invitation'),
    },
    {
      name: 'bound loosened beyond the deadline',
      table: 'scim_provisioning_tokens',
      mutate: (source: string) => source.replace(bound, "SET LOCAL lock_timeout = '14s';\n"),
    },
  ])(
    'lock-bound mutation "$name" leaves the $table wait unbounded',
    async (entry) => {
      const source = await readFile(join(migrationsDir, migration), 'utf8')
      const mutant = entry.mutate(source)
      expect(mutant).not.toBe(source)
      expect(lockedTables(mutant)).toEqual(lockedTables(source))
      const { directory, database } = await predecessor()
      try {
        await writeFile(join(directory, migration), mutant)
        await expect(heldLockFailsFast(database, directory, entry.table)).rejects.toMatchObject({
          name: 'AssertionError',
        })
      } finally {
        await database.drop()
        await rm(directory, { recursive: true, force: true })
      }
    },
    60_000,
  )

  it.each(['preservation', 'credential binding backfill'])(
    'detects %s source-copy mutation and restores the original assertion',
    async (protection) => {
      const source = await readFile(join(migrationsDir, migration), 'utf8')
      for (const mutated of [true, false]) {
        const { directory, database } = await predecessor()
        try {
          const before = await records(database.pool)
          await writeFile(
            join(directory, migration),
            mutated
              ? protection === 'preservation'
                ? `${source}\nUPDATE scim_provisioning_tokens SET name = 'mutated';`
                : source.replace(
                    /INSERT INTO scim_token_connections \(token_id, organization_id, connection_id\)\nSELECT[^;]+;/,
                    '',
                  )
              : source,
          )
          await runMigrations(database.pool, directory)
          const verify = async () => {
            if (protection === 'preservation')
              expect((await records(database.pool, before.tables)).data).toEqual(before.data)
            else
              expect(
                (
                  await database.pool.query(
                    'SELECT count(*)::integer AS count FROM scim_token_connections',
                  )
                ).rows,
              ).toEqual([{ count: 6 }])
          }
          if (mutated) await expect(verify()).rejects.toMatchObject({ name: 'AssertionError' })
          else await verify()
        } finally {
          await database.drop()
          await rm(directory, { recursive: true, force: true })
        }
      }
    },
    30_000,
  )
})
