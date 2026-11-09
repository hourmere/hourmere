import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDb } from './index.ts'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0048_api_key_scopes.sql'
const userId = '00000000-0000-4000-8000-000000000001'
const teamId = 'abcdef01-0000-4000-8000-000000000002'
const personalId = '00000000-0000-4000-8000-000000000003'
// Reuse one Node-clock instant so source-copy databases have identical fixtures.
const keyNow = Date.now()
// Locked Better Auth's defaultKeyHasher is SHA-256 encoded as unpadded base64url.
// These deterministic synthetic credentials are never included in assertion diagnostics.
const predecessorKey = (index: number) => `hm_${String.fromCharCode(65 + index).repeat(64)}`

// Mutation and malformed-row cases need only the real migrations defining their
// fixtures. Keep the complete predecessor in the upgrade/fresh-schema integration case.
const fixtureMigrations = new Set([
  '0001_auth.sql',
  '0002_scheduling.sql',
  '0003_schema_followups.sql',
  '0010_booking_cancellation_origin.sql',
  '0016_mcp_oauth.sql',
  '0030_mcp_oauth_client_activity.sql',
  '0047_event_type_durations.sql',
])

async function predecessorDirectory(complete = false) {
  const directory = await mkdtemp(join(tmpdir(), 'hourmere-scoped-keys-predecessor-'))
  for (const file of await readdir(migrationsDir)) {
    if (file.endsWith('.sql') && file < migration && (complete || fixtureMigrations.has(file))) {
      await copyFile(join(migrationsDir, file), join(directory, file))
    }
  }
  return directory
}

async function seed(pool: pg.Pool) {
  await pool.query(
    `INSERT INTO auth."user" (id,name,email,"emailVerified") VALUES ($1,'Synthetic scope owner','scope@example.test',true)`,
    [userId],
  )
  await pool.query(
    `INSERT INTO auth.organization (id,name,slug,"createdAt") VALUES ($1,'Synthetic team','scope-team',now())`,
    [teamId],
  )
  await pool.query(
    `INSERT INTO auth.member ("organizationId","userId",role,"createdAt") VALUES ($1,$2,'owner',now())`,
    [teamId, userId],
  )
  const metadata = [
    null,
    {},
    { organizationId: teamId },
    { organizationId: teamId.toUpperCase(), extra: { retained: [1, true, null] } },
    { scope: 'prefeature', extra: 'preserve' },
    { organizationId: null },
    { organizationId: 3 },
    { organizationId: [] },
    { organizationId: personalId },
  ]
  for (let index = 0; index < metadata.length; index++) {
    await pool.query(
      `INSERT INTO auth.apikey (id,"configId",name,start,"referenceId",prefix,key,"refillInterval","refillAmount","lastRefillAt",enabled,"rateLimitEnabled","rateLimitTimeWindow","rateLimitMax","requestCount",remaining,"lastRequest","expiresAt","createdAt","updatedAt",permissions,metadata)
      VALUES (('00000000-0000-4000-8001-' || lpad($1::text,12,'0'))::uuid,'default','Synthetic','hm_synthetic',$2,'hm_',$3,60000,100,'2026-01-01T00:00Z',$4,true,60000,600,23,77,'2026-01-02T00:00Z',$5,'2026-01-01T01:02:03.123456Z','2026-01-02T03:04:05.654321Z','{"retained":["permission"]}',$6)`,
      [
        index + 1,
        userId,
        createHash('sha256').update(predecessorKey(index)).digest('base64url'),
        index !== 3,
        // Better Auth verifies key expiry with its Node clock after migration.
        new Date(keyNow + (index === 4 ? -86_400_000 : 86_400_000)),
        metadata[index] === null ? null : JSON.stringify(metadata[index]),
      ],
    )
  }
  await pool.query(`
    INSERT INTO auth.organization (id,name,slug,metadata,"createdAt")
      VALUES ('00000000-0000-4000-8000-000000000003','Synthetic personal space',
        'scope-personal','{"kind":"personal","retained":true}','2026-01-01T01:02:03.123456Z');
    INSERT INTO personal_organizations (user_id,organization_id)
      VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003');
    INSERT INTO auth.member ("organizationId","userId",role,"createdAt")
      VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001',
        'owner','2026-01-01T01:02:03.123456Z');
    INSERT INTO auth.session (id,"userId",token,"expiresAt","createdAt","updatedAt","activeOrganizationId","ipAddress","userAgent")
      VALUES ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001',
        'synthetic-predecessor-session','2030-01-01T00:00Z','2026-01-01T01:02:03.123456Z',
        '2026-01-02T03:04:05.654321Z','abcdef01-0000-4000-8000-000000000002',
        '192.0.2.47','Synthetic predecessor session');
    INSERT INTO auth."oauthClient" ("clientId","userId",name,"redirectUris",scopes,"grantTypes",
      "tokenEndpointAuthMethod","requirePKCE",metadata,"createdAt","updatedAt")
      VALUES ('synthetic-scoped-migration-mcp','00000000-0000-4000-8000-000000000001',
        'Synthetic existing MCP connector','["https://connector.example.test/callback"]',
        '["mcp:tools"]','["authorization_code","refresh_token"]','none',true,
        '{"registration":"dynamic","retained":true}','2026-01-01T01:02:03.123456Z',
        '2026-01-02T03:04:05.654321Z');
    INSERT INTO mcp_oauth_grants (id,user_id,organization_id,client_id,created_at)
      VALUES ('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000001',
        'abcdef01-0000-4000-8000-000000000002','synthetic-scoped-migration-mcp','2026-01-01T01:02:03.123456Z');
    INSERT INTO auth."oauthConsent" (id,"clientId","userId","referenceId",resources,scopes,"createdAt","updatedAt")
      VALUES ('00000000-0000-4000-8000-000000000005','synthetic-scoped-migration-mcp',
        '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000006',
        '["https://hourmere.example.test/mcp"]','["mcp:tools"]','2026-01-01T01:02:03.123456Z',
        '2026-01-02T03:04:05.654321Z');
    INSERT INTO auth."oauthRefreshToken" (id,token,"clientId","sessionId","userId","referenceId",resources,
      scopes,"expiresAt","createdAt","rotatedAt","authTime")
      VALUES ('00000000-0000-4000-8000-000000000007','synthetic-predecessor-refresh-digest',
        'synthetic-scoped-migration-mcp','00000000-0000-4000-8000-000000000004',
        '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000006',
        '["https://hourmere.example.test/mcp"]','["mcp:tools"]','2030-01-01T00:00Z',
        '2026-01-01T01:02:03.123456Z','2026-01-02T03:04:05.654321Z','2026-01-01T01:02:03.123456Z');
    INSERT INTO auth."oauthAccessToken" (token,"clientId","sessionId","userId","referenceId",resources,
      "refreshId",scopes,"expiresAt","createdAt")
      VALUES ('synthetic-predecessor-access-digest','synthetic-scoped-migration-mcp',
        '00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000006','["https://hourmere.example.test/mcp"]',
        '00000000-0000-4000-8000-000000000007','["mcp:tools"]','2030-01-01T00:00Z',
        '2026-01-02T03:04:05.654321Z');
    INSERT INTO mcp_oauth_intents (user_id,session_id,grant_id,organization_id,request_hash,expires_at,used_at,created_at)
      VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004',
        '00000000-0000-4000-8000-000000000006','abcdef01-0000-4000-8000-000000000002',
        sha256(convert_to('synthetic-scoped-migration-intent','UTF8')),'2030-01-01T00:00Z',
        '2026-01-02T03:04:05.654321Z','2026-01-01T01:02:03.123456Z');
    INSERT INTO mcp_oauth_client_activity (client_id,consented_at,last_used_at)
      VALUES ('synthetic-scoped-migration-mcp','2026-01-01T01:02:03.123456Z','2026-01-02T03:04:05.654321Z');
    INSERT INTO event_types (organization_id,slug,title,duration_minutes,allowed_durations_minutes,
      location,created_at,updated_at)
      VALUES ('abcdef01-0000-4000-8000-000000000002','historical-multiple-durations',
        'Synthetic existing duration choices',45,ARRAY[90,45,15],
        '{"kind":"phone","number":"+15555550148"}',
        '2026-01-01T01:02:03.123456Z','2026-01-02T03:04:05.654321Z');
    INSERT INTO bookings (id,organization_id,status,start_at,end_at,title,location,responses,manage_token_hash,
      cancelled_at,cancel_reason,source,api_key_id,cancelled_source,cancelled_api_key_id,
      oauth_consent_id,cancelled_oauth_consent_id,idempotency_key,idempotency_fingerprint,created_at,updated_at)
      SELECT ('00000000-0000-4000-8002-' || lpad(n::text,12,'0'))::uuid,
        'abcdef01-0000-4000-8000-000000000002',CASE WHEN n<3 THEN 'cancelled' ELSE 'confirmed' END,
        '2026-12-01T09:00Z'::timestamptz+n*interval '1 day',
        '2026-12-01T09:30Z'::timestamptz+n*interval '1 day','Synthetic historical booking '||n,
        '{"kind":"phone","number":"+15555550147"}','{"purpose":"Preserve historical answers 東京"}',
        sha256(convert_to('synthetic-scope-booking-'||n,'UTF8')),
        CASE WHEN n<3 THEN '2026-02-01T01:02:03.123456Z'::timestamptz END,
        CASE WHEN n<3 THEN 'Synthetic historical cancellation' END,
        CASE WHEN n<3 THEN 'mcp' ELSE 'web' END,
        CASE WHEN n=1 THEN '00000000-0000-4000-8001-000000000003'::uuid END,
        CASE WHEN n=1 THEN 'api' WHEN n=2 THEN 'mcp' END,
        CASE WHEN n=1 THEN '00000000-0000-4000-8001-000000000001'::uuid END,
        CASE WHEN n=2 THEN '00000000-0000-4000-8000-000000000005'::uuid END,
        CASE WHEN n=2 THEN '00000000-0000-4000-8000-000000000005'::uuid END,
        'synthetic-shared-idempotency-namespace',sha256(convert_to('synthetic-scoped-request-'||n,'UTF8')),
        '2026-01-01T01:02:03.123456Z','2026-01-02T03:04:05.654321Z'
      FROM generate_series(1,3) AS n;
    INSERT INTO booking_hosts (booking_id,user_id)
      SELECT id,'00000000-0000-4000-8000-000000000001' FROM bookings;
    INSERT INTO booking_attendees (booking_id,name,email,time_zone,locale,is_booker)
      SELECT id,'Synthetic invitee 東京','invitee-'||id||'@example.test','America/Los_Angeles','en',true FROM bookings;
  `)
}

// Fingerprint every persisted column without ever putting session/OAuth tokens in diagnostics.
async function sentinelRecords(pool: pg.Pool) {
  const snapshots: Record<string, unknown[]> = {}
  const tables = [
    ['auth', 'user'],
    ['auth', 'organization'],
    ['auth', 'member'],
    ['auth', 'session'],
    ['auth', 'oauthClient'],
    ['auth', 'oauthConsent'],
    ['auth', 'oauthRefreshToken'],
    ['auth', 'oauthAccessToken'],
    ['public', 'personal_organizations'],
    ['public', 'mcp_oauth_grants'],
    ['public', 'mcp_oauth_intents'],
    ['public', 'mcp_oauth_client_activity'],
    ['public', 'event_types'],
    ['public', 'bookings'],
    ['public', 'booking_hosts'],
    ['public', 'booking_attendees'],
  ] as const
  for (const [schema, table] of tables) {
    snapshots[`${schema}.${table}`] = (
      await pool.query(
        `SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS fingerprint,
        xmin::text,ctid::text FROM "${schema}"."${table}" t ORDER BY fingerprint`,
      )
    ).rows
  }
  return snapshots
}

async function records(pool: pg.Pool) {
  return (
    await pool.query(
      `SELECT id,to_jsonb(k) - 'metadata' AS preserved, metadata::jsonb AS metadata FROM auth.apikey k ORDER BY id`,
    )
  ).rows
}

const sqlstate = async (work: Promise<unknown>) => {
  try {
    await work
    return null
  } catch (error) {
    return (error as { code?: string }).code
  }
}

async function afterFixtureWork<T extends { setup?: Promise<void>; pending?: Promise<void> }>(
  state: T,
  cleanup: (state: T) => Promise<void>,
) {
  await Promise.allSettled([state.setup, state.pending])
  await cleanup(state)
}

it('drains aborted fixture work and releases only its original database after the next case starts', async () => {
  const barrier = Promise.withResolvers<void>()
  const controller = new AbortController()
  const released: string[] = []
  const first = {
    id: 'first',
    pending: barrier.promise.then(() => controller.signal.throwIfAborted()),
  }
  let current = first
  const release = async (state: { id: string }) => {
    released.push(state.id)
  }
  const firstCleanup = afterFixtureWork(current, release)
  controller.abort(new Error('Synthetic fixture timeout'))
  try {
    expect(released).toEqual([])
    // Model a timed-out teardown whose old promise still runs after the runner
    // has started another case. Old cleanup must retain its original owner.
    current = { id: 'second', pending: Promise.resolve() }
    await afterFixtureWork(current, release)
    expect(released).toEqual(['second'])
  } finally {
    barrier.resolve()
    await firstCleanup
  }
  expect(released).toEqual(['second', 'first'])
})

describe.skipIf(!serverUrl)('API key scope migration', () => {
  const databases: TestDatabase[] = []
  const available: TestDatabase[] = []
  beforeAll(async () => {
    // Physical CREATE/DROP can wait for shared-server checkpoints. Reuse two
    // owned databases and reset their schemas between cases instead of paying
    // that cost twice in every mutation test.
    for (let index = 0; index < 2; index++) {
      const database = await createTestDatabase(serverUrl as string, undefined, { migrate: false })
      databases.push(database)
      available.push(database)
    }
  })
  afterAll(async () => {
    await Promise.all(databases.map((database) => database.drop()))
  })
  async function fixtureDatabase(directory: string, migrate = true): Promise<TestDatabase> {
    const database = available.pop()
    if (!database) throw new Error('No isolated migration fixture database available')
    let dropping: Promise<void> | undefined
    const drop = () => {
      dropping ??= (async () => {
        await database.pool.query(
          'DROP SCHEMA IF EXISTS auth CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;',
        )
        available.push(database)
      })()
      return dropping
    }
    try {
      if (migrate) await runMigrations(database.pool, directory)
      return { ...database, drop }
    } catch (error) {
      await drop()
      throw error
    }
  }

  describe('complete predecessor upgrade', () => {
    let directory: string
    let upgraded: TestDatabase
    let fresh: TestDatabase
    let before: Awaited<ReturnType<typeof records>>
    let sentinels: Awaited<ReturnType<typeof sentinelRecords>>
    let applied: string[]
    beforeAll(async () => {
      // Prepare the two historical schemas once. The cases below separately prove
      // data/schema preservation and real credential verification on that full upgrade.
      directory = await predecessorDirectory(true)
      upgraded = await fixtureDatabase(directory)
      await seed(upgraded.pool)
      before = await records(upgraded.pool)
      sentinels = await sentinelRecords(upgraded.pool)
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      applied = await runMigrations(upgraded.pool, directory)
      fresh = await fixtureDatabase(directory)
    })
    afterAll(async () => {
      await fresh?.drop()
      await upgraded?.drop()
      if (directory) await rm(directory, { recursive: true, force: true })
    })

    it('preserves real predecessor keys, backfills full, matches fresh schema and reruns without writes', async () => {
      for (const rows of Object.values(sentinels)) expect(rows.length).toBeGreaterThan(0)
      expect(applied).toEqual([migration])
      expect(await records(upgraded.pool)).toEqual(
        before.map((row) => ({ ...row, metadata: { ...row.metadata, scope: 'full' } })),
      )
      expect(await sentinelRecords(upgraded.pool)).toEqual(sentinels)
      // Newly issued restricted keys must survive subsequent startup migration checks too.
      await upgraded.pool.query(`INSERT INTO auth.apikey ("configId","referenceId",key,"createdAt","updatedAt",metadata)
        VALUES ('default','00000000-0000-4000-8000-000000000001','synthetic-post-upgrade',now(),now(),'{"scope":"read"}')`)
      const after = await records(upgraded.pool)
      const tuples = (
        await upgraded.pool.query('SELECT id,xmin::text,ctid::text FROM auth.apikey ORDER BY id')
      ).rows
      const schema = await snapshotSchema(upgraded.pool)
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      expect(await records(upgraded.pool)).toEqual(after)
      expect(
        (await upgraded.pool.query('SELECT id,xmin::text,ctid::text FROM auth.apikey ORDER BY id'))
          .rows,
      ).toEqual(tuples)
      expect(await sentinelRecords(upgraded.pool)).toEqual(sentinels)
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
    })

    it('authenticates preserved predecessor credentials with full scope and retains disabled/expired failures', async () => {
      let authPool: ReturnType<typeof createAuthPool> | undefined
      try {
        const signup = { mode: 'open', allowedDomains: [] } as const
        authPool = createAuthPool(upgraded.url, signup)
        const auth = createAuth({
          pool: authPool,
          db: createDb(upgraded.pool),
          baseURL: 'http://localhost:43847',
          secret: 'synthetic-predecessor-scope-authentication-secret-32-characters',
          signup,
          mailer: { send: async () => {} },
        })
        const resolve = createCallerResolver({ auth, db: createDb(upgraded.pool) })
        // Real plugin verification proves the retained digests still authenticate as full,
        // including absent/null/non-string organization fallbacks and explicit personal/team pins.
        for (const index of [0, 1, 2, 5, 6, 7, 8]) {
          const result = await resolve(
            new Headers({ authorization: `Bearer ${predecessorKey(index)}` }),
          )
          expect(result).toMatchObject({
            ok: true,
            principal: {
              kind: 'api_key',
              apiKeyScope: 'full',
              user: { id: userId },
              organization: { id: index === 2 ? teamId : personalId, personal: index !== 2 },
            },
          })
        }
        // Disabled and expired predecessor keys keep their previous credential failure.
        for (const index of [3, 4]) {
          expect(
            await resolve(new Headers({ authorization: `Bearer ${predecessorKey(index)}` })),
          ).toMatchObject({ ok: false, error: 'unauthorized' })
        }
        expect(await sentinelRecords(upgraded.pool)).toEqual(sentinels)
        expect(authPool.totalCount).toBeLessThanOrEqual(3)
        expect(upgraded.pool.totalCount).toBeLessThanOrEqual(3)
      } finally {
        await authPool?.end()
      }
    })
  })

  it.each(['{broken', '[]', 'null', '"string"', '3'])(
    'fails atomically on malformed or non-object predecessor metadata (%s)',
    async (invalid) => {
      const directory = await predecessorDirectory()
      let database: TestDatabase | undefined
      try {
        database = await fixtureDatabase(directory)
        await seed(database.pool)
        await database.pool.query(
          'UPDATE auth.apikey SET metadata=$1 WHERE name=$2 AND enabled=false',
          [invalid, 'Synthetic'],
        )
        const before = (
          await database.pool.query('SELECT to_jsonb(k) AS row FROM auth.apikey k ORDER BY id')
        ).rows
        await copyFile(join(migrationsDir, migration), join(directory, migration))
        await expect(runMigrations(database.pool, directory)).rejects.toMatchObject({
          cause: { code: '23514', message: 'API_KEY_METADATA_MIGRATION_INVALID', detail: '1' },
        })
        expect(
          (await database.pool.query('SELECT to_jsonb(k) AS row FROM auth.apikey k ORDER BY id'))
            .rows,
        ).toEqual(before)
        expect(
          (
            await database.pool.query('SELECT name FROM schema_migrations WHERE name=$1', [
              migration,
            ])
          ).rowCount,
        ).toBe(0)
        expect(
          (
            await database.pool.query(
              "SELECT tgname FROM pg_trigger WHERE tgname='api_key_scope_guard'",
            )
          ).rowCount,
        ).toBe(0)
      } finally {
        await database?.drop()
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  it('canonicalizes direct inserts and refuses invalid, changed or removed scopes while allowing native maintenance', async () => {
    const directory = await predecessorDirectory()
    let database: TestDatabase | undefined
    try {
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      database = await fixtureDatabase(directory)
      const pool = database.pool
      const insert = (metadata: string | null) =>
        pool.query(
          `INSERT INTO auth.apikey ("configId","referenceId",key,"createdAt","updatedAt",metadata) VALUES ('default','synthetic-owner','synthetic-hash',now(),now(),$1) RETURNING id,metadata::jsonb`,
          [metadata],
        )
      for (const metadata of [null, '{}', '{"extra":"retained"}']) {
        expect((await insert(metadata)).rows[0]?.metadata.scope).toBe('full')
      }
      for (const scope of ['full', 'read', 'bookings']) {
        const { id } = (await insert(JSON.stringify({ scope }))).rows[0] as { id: string }
        for (const metadata of [
          null,
          '{}',
          JSON.stringify({ scope: scope === 'read' ? 'full' : 'read' }),
        ]) {
          expect(
            await sqlstate(
              pool.query('UPDATE auth.apikey SET metadata=$1 WHERE id=$2', [metadata, id]),
            ),
          ).toBe('23514')
        }
        await expect(
          pool.query(
            'UPDATE auth.apikey SET enabled=false,"requestCount"=4,"lastRequest"=now(),"expiresAt"=now(),metadata=$1 WHERE id=$2',
            [JSON.stringify({ scope, organizationId: '00000000-0000-4000-8000-000000000099' }), id],
          ),
        ).resolves.toMatchObject({ rowCount: 1 })
        expect(
          (await pool.query('SELECT metadata::jsonb FROM auth.apikey WHERE id=$1', [id])).rows[0]
            ?.metadata.scope,
        ).toBe(scope)
      }
      for (const metadata of [
        '{broken',
        '[]',
        'null',
        '{"scope":null}',
        '{"scope":"READ"}',
        '{"scope":[]}',
        '{"scope":4}',
      ]) {
        expect(await sqlstate(insert(metadata))).toBe('23514')
      }
    } finally {
      await database?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  })
  describe.each([
    'backfill',
    'hash preservation',
    'organization preservation',
    'state preservation',
    'immutable trigger',
    'session preservation',
    'OAuth grant preservation',
    'booking attribution preservation',
    'duration configuration preservation',
  ] as const)('source-copy %s migration protection', (protection) => {
    interface FixtureState {
      directory?: string
      database?: TestDatabase
      before?: Awaited<ReturnType<typeof records>>
      sentinels?: Awaited<ReturnType<typeof sentinelRecords>>
      setup?: Promise<void>
      pending?: Promise<void>
    }
    let state: FixtureState
    beforeEach(() => {
      const current: FixtureState = {}
      state = current
      current.setup = (async () => {
        current.directory = await predecessorDirectory()
        current.database = await fixtureDatabase(current.directory)
        await seed(current.database.pool)
        current.before = await records(current.database.pool)
        current.sentinels = await sentinelRecords(current.database.pool)
      })()
      return current.setup
    })
    afterEach(async () => {
      // Capture ownership before awaiting: even if teardown itself times out,
      // its continuation must never release a subsequent case's database.
      await afterFixtureWork(state, async (current) => {
        try {
          await current.database?.drop()
        } finally {
          if (current.directory) await rm(current.directory, { recursive: true, force: true })
        }
      })
    })
    for (const variant of ['mutated', 'restored'] as const) {
      it(`checks ${variant} SQL against the preservation assertion`, ({ signal }) => {
        const current = state
        current.pending = (async () => {
          const fixture = current.database
          const path = current.directory
          const before = current.before
          const sentinels = current.sentinels
          if (!fixture || !path || !before || !sentinels)
            throw new Error('Migration fixture setup did not complete')
          signal.throwIfAborted()
          const source = await readFile(join(migrationsDir, migration), 'utf8')
          let mutant = source
          if (protection === 'backfill')
            mutant = source.replace(
              'UPDATE auth.apikey\nSET metadata = (coalesce(metadata::jsonb, \'{}\'::jsonb) || \'{"scope":"full"}\'::jsonb)::text;',
              'SELECT 1;',
            )
          if (protection === 'hash preservation')
            mutant += "\nUPDATE auth.apikey SET key='mutated-synthetic-hash';"
          if (protection === 'organization preservation')
            mutant +=
              "\nUPDATE auth.apikey SET metadata=(metadata::jsonb - 'organizationId')::text;"
          if (protection === 'state preservation')
            mutant += '\nUPDATE auth.apikey SET enabled=true;'
          if (protection === 'immutable trigger')
            mutant = source.replace(
              "IF parsed -> 'scope' IS DISTINCT FROM old_scope THEN",
              'IF false THEN',
            )
          if (protection === 'session preservation')
            mutant += `\nUPDATE auth.session SET "activeOrganizationId"='00000000-0000-4000-8000-000000000003';`
          if (protection === 'OAuth grant preservation')
            mutant +=
              "\nUPDATE mcp_oauth_grants SET organization_id='00000000-0000-4000-8000-000000000003';"
          if (protection === 'booking attribution preservation')
            mutant +=
              '\nUPDATE bookings SET api_key_id=null,cancelled_api_key_id=null,idempotency_key=null,idempotency_fingerprint=null;'
          if (protection === 'duration configuration preservation')
            mutant += '\nUPDATE event_types SET allowed_durations_minutes=ARRAY[duration_minutes];'
          expect(mutant).not.toBe(source)
          signal.throwIfAborted()
          await writeFile(join(path, migration), variant === 'mutated' ? mutant : source)
          signal.throwIfAborted()
          await runMigrations(fixture.pool, path)
          signal.throwIfAborted()
          const assertPreserved = async (pool: pg.Pool, expectedSentinels = sentinels) => {
            if (protection === 'immutable trigger') {
              expect(
                await sqlstate(
                  pool.query(
                    "UPDATE auth.apikey SET metadata=jsonb_set(metadata::jsonb,'{scope}','\"read\"')::text",
                  ),
                ),
              ).toBe('23514')
            } else {
              expect(await records(pool)).toEqual(
                before.map((row) => ({ ...row, metadata: { ...row.metadata, scope: 'full' } })),
              )
              expect(await sentinelRecords(pool)).toEqual(expectedSentinels)
            }
          }
          if (variant === 'mutated') {
            await expect(assertPreserved(fixture.pool)).rejects.toMatchObject({
              name: 'AssertionError',
            })
          } else {
            await assertPreserved(fixture.pool)
          }
        })()
        return current.pending
      })
    }
  })
})
