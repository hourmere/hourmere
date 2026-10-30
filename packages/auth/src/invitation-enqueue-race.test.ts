import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type Auth, createAuth, createAuthPool } from './index.ts'
import type { EnqueueInvitationEmail } from './invitations.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:43831'
const secret = randomBytes(32).toString('base64')
const unavailable = {
  code: 'INVITATION_DELIVERY_UNAVAILABLE',
  message: 'The invitation was saved, but delivery could not be queued. Try again later.',
}
const ineligible = {
  code: 'INVITATION_INELIGIBLE',
  message: 'This invitation is no longer pending. Create a new invitation if needed.',
}

interface Actor {
  organizationId: string
  cookie: string
}

function moduleUrl(source: string, location: URL, replacements: Record<string, string> = {}) {
  const javascript = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) => {
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
    },
  )
  return `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
}

// Runtime source copies isolate the mutation from production files and other workers.
async function authSourceCopy(disableRetirementCheck: boolean): Promise<typeof createAuth> {
  const serviceLocation = new URL('./invitations.ts', import.meta.url)
  let source = readFileSync(serviceLocation, 'utf8')
  const seam = '      if (retired) throw ineligible()'
  expect(source.includes(seam), 'mutation finds the fresh eligibility decision').toBe(true)
  if (disableRetirementCheck) source = source.replace(seam, '      void retired')
  const serviceUrl = moduleUrl(source, serviceLocation)
  const hookLocation = new URL('./hooks.ts', import.meta.url)
  const hookUrl = moduleUrl(readFileSync(hookLocation, 'utf8'), hookLocation, {
    './invitations.ts': serviceUrl,
  })
  const authLocation = new URL('./index.ts', import.meta.url)
  const copy = await import(
    moduleUrl(readFileSync(authLocation, 'utf8'), authLocation, { './hooks.ts': hookUrl })
  )
  return copy.createAuth
}

describe.skipIf(!serverUrl)('invitation eligibility after a post-commit queue failure', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'invite_enqueue' })
    db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, { mode: 'open', allowedDomains: [] })
  })

  beforeEach(async () => {
    await owned.pool.query('DELETE FROM auth.organization')
    await owned.pool.query('DELETE FROM auth."user"')
  })

  afterAll(async () => {
    try {
      await authPool?.end()
    } finally {
      await owned?.drop()
    }
  })

  function instance(enqueue: EnqueueInvitationEmail, factory = createAuth, database = db) {
    return factory({
      pool: authPool,
      db: database,
      baseURL: origin,
      secret,
      signup: { mode: 'closed', allowedDomains: [] },
      mailer: { send: async () => {} },
      enqueueInvitationEmail: enqueue,
    })
  }

  async function actor(organizationId?: string): Promise<Actor> {
    const user = await db
      .insertInto('auth.user')
      .values({
        name: 'Synthetic invitation administrator',
        email: `${randomUUID()}@outside.example`,
        emailVerified: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const orgId =
      organizationId ??
      (
        await db
          .insertInto('auth.organization')
          .values({ name: 'Synthetic invitation team', slug: randomUUID(), createdAt: new Date() })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id
    await db
      .insertInto('auth.member')
      .values({ userId: user.id, organizationId: orgId, role: 'admin', createdAt: new Date() })
      .execute()
    const token = randomBytes(24).toString('base64url')
    await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        activeOrganizationId: orgId,
      })
      .execute()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      organizationId: orgId,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }

  function post(auth: Auth, admin: Actor, path: string, body: Record<string, unknown>) {
    return auth.handler(
      new Request(`${origin}/api/auth/organization/${path}`, {
        method: 'POST',
        headers: {
          origin,
          cookie: admin.cookie,
          'content-type': 'application/json',
          'x-expected-organization-id': admin.organizationId,
        },
        body: JSON.stringify(body),
      }),
    )
  }

  function invite(auth: Auth, admin: Actor) {
    return post(auth, admin, 'invite-member', {
      organizationId: admin.organizationId,
      role: 'member',
      email: `${randomUUID()}@outside.example`,
    })
  }

  async function verifyRetired(
    status: 'canceled' | 'accepted' | 'rejected' | 'expired' | 'missing',
    factory = createAuth,
  ) {
    const reached = Promise.withResolvers<{ invitationId: string; generation: number }>()
    const release = Promise.withResolvers<void>()
    const auth = instance(async (payload) => {
      reached.resolve(payload)
      await release.promise
      throw new Error('synthetic queue failure containing private request details')
    }, factory)
    const admin = await actor()
    const canceller = await actor(admin.organizationId)
    const request = invite(auth, admin)
    let response: Response
    try {
      const payload = await Promise.race([
        reached.promise,
        request.then(() => {
          throw new Error('invitation answered before the post-commit queue barrier')
        }),
      ])
      if (status === 'canceled') {
        const canceled = await post(auth, canceller, 'cancel-invitation', {
          invitationId: payload.invitationId,
        })
        expect(canceled.status).toBe(200)
      } else if (status === 'missing') {
        await db.deleteFrom('auth.invitation').where('id', '=', payload.invitationId).execute()
      } else {
        await db
          .updateTable('auth.invitation')
          .set(status === 'expired' ? { expiresAt: new Date(Date.now() - 1000) } : { status })
          .where('id', '=', payload.invitationId)
          .execute()
      }
    } finally {
      release.resolve()
      response = await request
    }
    expect(response.status, 'a retired invitation uses the existing unavailable wording').toBe(409)
    expect(await response.json()).toEqual(ineligible)
  }

  it.each(['canceled', 'accepted', 'rejected', 'expired', 'missing'] as const)(
    'does not suggest retrying an invitation that became %s during enqueue',
    async (status) => {
      await verifyRetired(status)
    },
  )

  it('preserves a sanitized retryable queue error for a still-pending invitation', async () => {
    const auth = instance(async () => {
      throw new Error('synthetic queue failure containing private request details')
    })
    const response = await invite(auth, await actor())
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual(unavailable)
    expect(await db.selectFrom('auth.invitation').select('status').execute()).toEqual([
      { status: 'pending' },
    ])
  })

  it('preserves the sanitized queue error when the eligibility recheck fails', async () => {
    let queueFailed = false
    const database = new Proxy(db, {
      get(target, property) {
        if (property === 'selectFrom') {
          return (...args: Parameters<Db['selectFrom']>) => {
            if (queueFailed) throw new Error('synthetic private database details')
            return target.selectFrom(...args)
          }
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const auth = instance(
      async () => {
        queueFailed = true
        throw new Error('synthetic private queue details')
      },
      createAuth,
      database,
    )
    const response = await invite(auth, await actor())
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual(unavailable)
  })

  it('runs the unchanged source copy through the concurrent cancellation assertion', async () => {
    await verifyRetired('canceled', await authSourceCopy(false))
  })

  it('detects the removed post-commit retirement decision with a real HTTP assertion', async () => {
    await expect(verifyRetired('canceled', await authSourceCopy(true))).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining(
        'a retired invitation uses the existing unavailable wording',
      ),
    })
  })
})
