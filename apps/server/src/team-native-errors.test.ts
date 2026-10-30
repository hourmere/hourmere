import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4389'
const secret = randomBytes(32).toString('base64')
const failure = 'synthetic native member insertion failure'

function moduleUrl(source: string, location: URL, replacements: Record<string, string> = {}) {
  const code = stripTypeScriptTypes(source).replace(/from '([^']+)'/g, (_, specifier: string) => {
    let resolved = replacements[specifier]
    if (!resolved) {
      if (specifier.startsWith('.')) resolved = new URL(specifier, location).href
      else {
        try {
          resolved = import.meta.resolve(specifier)
        } catch {
          resolved = pathToFileURL(createRequire(location).resolve(specifier)).href
        }
      }
    }
    return `from '${resolved}'`
  })
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
}

async function sourceCopy(mutation?: 'restore' | 'filter'): Promise<typeof createAuth> {
  const location = new URL('../../../packages/auth/src/team-native-atomicity.ts', import.meta.url)
  let source = readFileSync(location, 'utf8')
  if (mutation) {
    const protection =
      mutation === 'restore'
        ? "if (originalError !== undefined && databaseErrorCode(error) === '25P02') {"
        : 'if (isOriginalDatabaseError(error)) {'
    expect(source.includes(protection), `${mutation} mutation matches its error protection`).toBe(
      true,
    )
    source = source.replace(protection, mutation === 'restore' ? 'if (false) {' : 'if (true) {')
  }
  const authLocation = new URL('../../../packages/auth/src/index.ts', import.meta.url)
  const auth = await import(
    moduleUrl(readFileSync(authLocation, 'utf8'), authLocation, {
      './team-native-atomicity.ts': moduleUrl(source, location),
    })
  )
  return auth.createAuth
}

describe.skipIf(!serverUrl)('native team transaction failure diagnostics', () => {
  let owned: TestDatabase
  let db: Db
  let pool: pg.Pool

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'team_errors' })
    db = createDb(owned.pool)
    // Reuse one auth pool across real and source-copy fixtures, then close it before DROP.
    pool = createAuthPool(owned.url, { mode: 'open', allowedDomains: [] })
    await owned.pool.query(`CREATE FUNCTION public.fail_native_member_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NOT EXISTS (SELECT FROM auth.invitation
          WHERE "organizationId" = NEW."organizationId" AND status = 'accepted') THEN
          RAISE EXCEPTION 'native invitation status was not written first';
        END IF;
        RAISE EXCEPTION '${failure}' USING ERRCODE = '23514';
      END $$`)
  })
  beforeEach(async () => {
    await owned.pool.query('DELETE FROM auth.organization')
    await owned.pool.query('DELETE FROM auth."user"')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(async () => {
    await owned.pool.query('DROP TRIGGER IF EXISTS fail_native_member_insert ON auth.member')
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    try {
      await pool?.end()
    } finally {
      await owned?.drop()
    }
  })

  async function account() {
    const user = await db
      .insertInto('auth.user')
      .values({
        name: 'Synthetic transaction error account',
        email: `${randomUUID()}@outside.example`,
        emailVerified: true,
      })
      .returning(['id', 'email'])
      .executeTakeFirstOrThrow()
    const token = randomBytes(24).toString('base64url')
    await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .execute()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      ...user,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }

  async function fixture(factory = createAuth) {
    const owner = await account()
    const recipient = await account()
    const team = await db
      .insertInto('auth.organization')
      .values({
        name: 'Synthetic transaction error team',
        slug: randomUUID(),
        createdAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.member')
      .values({ organizationId: team.id, userId: owner.id, role: 'owner', createdAt: new Date() })
      .execute()
    const invitation = await db
      .insertInto('auth.invitation')
      .values({
        organizationId: team.id,
        inviterId: owner.id,
        email: recipient.email,
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const auth = factory({
      pool,
      db,
      baseURL: origin,
      secret,
      signup: { mode: 'open', allowedDomains: [] },
      mailer: { send: async () => {} },
    })
    await owned.pool.query(`CREATE TRIGGER fail_native_member_insert
      BEFORE INSERT ON auth.member FOR EACH ROW
      EXECUTE FUNCTION public.fail_native_member_insert()`)
    return { auth, recipient, team, invitation }
  }

  async function verifyRollback(f: Awaited<ReturnType<typeof fixture>>) {
    expect(
      await db
        .selectFrom('auth.invitation')
        .select('status')
        .where('id', '=', f.invitation.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'pending' })
    expect(
      await db
        .selectFrom('auth.member')
        .select('id')
        .where('organizationId', '=', f.team.id)
        .where('userId', '=', f.recipient.id)
        .execute(),
    ).toEqual([])
  }

  async function verifyOriginalError(factory = createAuth) {
    const f = await fixture(factory)
    const error = await f.auth.api
      .acceptInvitation({
        body: { invitationId: f.invitation.id },
        headers: new Headers({ cookie: f.recipient.cookie, origin }),
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(error, 'the original PostgreSQL failure survives native compensation').toMatchObject({
      code: '23514',
      message: failure,
    })
    await verifyRollback(f)
  }

  async function verifyHandledAdapterError(factory = createAuth) {
    const f = await fixture(factory)
    const { adapter } = await f.auth.$context
    const error = await adapter
      .transaction(async (trx) => {
        // The factory rejects an unknown model before executing SQL. Handle that
        // ordinary adapter error, then let this same real transaction continue.
        await expect(
          trx.findOne({ model: 'synthetic_unknown_model', where: [] }),
        ).rejects.toMatchObject({
          message: 'Model "synthetic_unknown_model" not found in schema',
        })
        await trx.update({
          model: 'invitation',
          where: [{ field: 'id', value: f.invitation.id }],
          update: { status: 'accepted' },
        })
        try {
          await trx.create({
            model: 'member',
            data: {
              organizationId: f.team.id,
              userId: f.recipient.id,
              role: 'member',
              createdAt: new Date(),
            },
          })
        } catch (original) {
          expect(original).toMatchObject({ code: '23514', message: failure })
          // Reproduce the native endpoint's compensation on the aborted transaction.
          await trx.update({
            model: 'invitation',
            where: [{ field: 'id', value: f.invitation.id }],
            update: { status: 'pending' },
          })
          throw original
        }
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(
      error,
      'a handled non-database adapter failure cannot replace the SQL cause',
    ).toMatchObject({ code: '23514', message: failure })
    await verifyRollback(f)
  }

  it('surfaces the original PostgreSQL exception to trusted native API callers', async () => {
    await verifyOriginalError()
  })

  it('logs the original failure while retaining the opaque HTTP 500 and rollback', async () => {
    const f = await fixture()
    const app = createApp({
      authHandler: f.auth.handler,
      resolveCaller: createCallerResolver({ auth: f.auth, db }),
      checkDb: async () => {},
      publicUrl: origin,
    })
    const response = await app.request('/api/auth/organization/accept-invitation', {
      method: 'POST',
      headers: { cookie: f.recipient.cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ invitationId: f.invitation.id }),
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'internal_error' })
    const errors = vi.mocked(console.error).mock.calls.flat().join(' ')
    expect(errors).toContain(failure)
    expect(errors).toContain('23514')
    expect(errors).not.toContain('25P02')
    await verifyRollback(f)
  })

  it('retains the original exception with an unchanged source copy', async () => {
    await verifyOriginalError(await sourceCopy())
  })

  it('retains the SQL cause after a handled non-database adapter failure', async () => {
    await verifyHandledAdapterError()
  })

  it('detects removal of original-error restoration with a real database assertion', async () => {
    await expect(verifyOriginalError(await sourceCopy('restore'))).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining(
        'the original PostgreSQL failure survives native compensation',
      ),
    })
  })

  it('detects removal of the SQLSTATE filter with a real database assertion', async () => {
    await expect(verifyHandledAdapterError(await sourceCopy('filter'))).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining(
        'a handled non-database adapter failure cannot replace the SQL cause',
      ),
    })
  })
})
