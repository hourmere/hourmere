import { createHmac, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { getRequestListener } from '@hono/node-server'
import { createApp } from '../../apps/server/src/app.ts'
import { productRoutes } from '../../apps/server/src/server.ts'
import {
  createAuth,
  createAuthPool,
  createCallerResolver,
  ensurePersonalOrganization,
} from '../../packages/auth/src/index.ts'
import { createDb, createPool } from '../../packages/db/src/index.ts'
import { createTestDatabase } from '../../packages/db/src/testing.ts'
import type { MailMessage } from '../../packages/mail/src/index.ts'
import { createFixtures } from '../../packages/scheduling/src/testing.ts'
import { test as base, expect } from './fixtures.ts'
import { listenOwned, type OwnedListener } from './listeners.ts'

interface InvitationApp {
  url: string
  path: string
  email: string
  mailLink: () => string | undefined
  signIn: (account?: 'recipient' | 'other' | 'unverified') => Promise<void>
  state: () => Promise<{ status: string; joined: boolean; activeTeam: boolean }>
  expire: () => Promise<void>
}

export const test = base.extend<{ invitationApp: InvitationApp }>({
  invitationApp: async ({ context }, use) => {
    const bootstrap = process.env.HOURMERE_E2E_BOOTSTRAP_URL
    if (!bootstrap) throw new Error('Invitation fixtures require HOURMERE_E2E_BOOTSTRAP_URL')
    const owned = await createTestDatabase(bootstrap)
    let listener: OwnedListener | undefined
    let authPool: ReturnType<typeof createAuthPool> | undefined
    let externalRequests = 0
    try {
      listener = await listenOwned(createServer())
      const { server, url } = listener
      const db = createDb(owned.pool)
      const fixtures = createFixtures(db)
      const owner = await fixtures.host({ name: 'Inviting owner', handle: null })
      const team = await fixtures.organization('Invitation team')
      await fixtures.member(owner.userId, team, 'owner')
      const email = 'recipient@hourmere.invalid'
      const invitation = await db
        .insertInto('auth.invitation')
        .values({
          organizationId: team,
          email,
          role: 'member',
          status: 'pending',
          inviterId: owner.userId,
          expiresAt: new Date(Date.now() + 86_400_000),
          createdAt: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const path = `/app/join?${new URLSearchParams({ invitationId: invitation.id })}`
      const secret = randomBytes(32).toString('base64')
      const signup = { mode: 'closed', allowedDomains: [] } as const
      const client = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' }
      const messages: MailMessage[] = []
      const vouching = {
        getUserInfo: async () => ({
          user: { email, emailVerified: true, name: 'Invited member' },
          data: { oid: 'synthetic-invited-member', sub: 'synthetic-invited-member' } as never,
        }),
      }
      authPool = createAuthPool(owned.url, signup)
      const auth = createAuth({
        pool: authPool,
        db,
        baseURL: url,
        secret,
        signup,
        mailer: { send: async (message) => void messages.push(message) },
        socialProviders: { google: client, microsoft: client },
        socialProviderOptions: { google: vouching, microsoft: vouching },
      })
      // Keep the real state/PKCE/callback and signup hooks. Only the provider-side
      // exchange and profile are synthetic, as in the standalone auth tests.
      for (const provider of (await auth.$context).socialProviders)
        provider.validateAuthorizationCode = async ({ code, codeVerifier, redirectURI }) => {
          if (
            code !== 'synthetic-invitation-code' ||
            !codeVerifier ||
            redirectURI !== `${url}/api/auth/callback/${provider.id}`
          )
            throw new Error('Unexpected synthetic provider exchange')
          return { accessToken: 'synthetic-access-token', scopes: ['openid', 'profile', 'email'] }
        }
      const app = createApp({
        publicUrl: url,
        checkDb: async () => {},
        authHandler: auth.handler,
        resolveCaller: createCallerResolver({ auth, db }),
        webDist:
          process.env.HOURMERE_E2E_WEB_DIST ??
          fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
        routes: productRoutes({
          db,
          publicUrl: url,
          socialProviders: { google: client, microsoft: client },
        }),
      })
      server.on('request', getRequestListener(app.fetch, { hostname: '127.0.0.1' }))
      await context.route('**/*', async (route) => {
        const request = route.request()
        const target = new URL(request.url())
        if (target.origin === url) return route.continue()
        const provider =
          target.origin === 'https://accounts.google.com'
            ? 'google'
            : target.origin === 'https://login.microsoftonline.com'
              ? 'microsoft'
              : undefined
        if (provider && request.isNavigationRequest()) {
          expect(
            target.searchParams.get('redirect_uri') === `${url}/api/auth/callback/${provider}`,
          ).toBe(true)
          expect(target.searchParams.has('state')).toBe(true)
          expect(target.searchParams.has('code_challenge')).toBe(true)
          // The private return path remains in Hourmere's OAuth state. Neither the
          // provider URL nor its Referer may carry the invitation capability.
          expect(request.url().includes(invitation.id)).toBe(false)
          expect((request.headers().referer ?? '').includes(invitation.id)).toBe(false)
          const callback = new URL(`/api/auth/callback/${provider}`, url)
          callback.search = new URLSearchParams({
            state: target.searchParams.get('state') ?? '',
            code: 'synthetic-invitation-code',
          }).toString()
          return route.fulfill({
            status: 200,
            contentType: 'text/html',
            headers: { 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' },
            body: `<!doctype html><meta name="referrer" content="no-referrer"><script>location.replace(${JSON.stringify(callback.href).replaceAll('<', '\\u003c')})</script>`,
          })
        }
        externalRequests++
        return route.abort('blockedbyclient')
      })
      await use({
        url,
        path,
        email,
        mailLink: () => messages.at(-1)?.text.match(/https?:\/\/[^\s]+/)?.[0],
        signIn: async (account = 'recipient') => {
          const selected = account === 'other' ? 'other@hourmere.invalid' : email
          const existing = await db
            .selectFrom('auth.user')
            .select('id')
            .where('email', '=', selected)
            .executeTakeFirst()
          const user =
            existing ??
            (await db
              .insertInto('auth.user')
              .values({
                name: 'Synthetic member',
                email: selected,
                emailVerified: account !== 'unverified',
              })
              .returning('id')
              .executeTakeFirstOrThrow())
          const personal = await ensurePersonalOrganization(db, user.id)
          const token = randomBytes(24).toString('base64url')
          await db
            .insertInto('auth.session')
            .values({
              userId: user.id,
              token,
              expiresAt: new Date(Date.now() + 3_600_000),
              updatedAt: new Date(),
              activeOrganizationId: personal,
            })
            .execute()
          const value = encodeURIComponent(
            `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`,
          )
          await context.addCookies([
            { name: 'better-auth.session_token', value, url, httpOnly: true, sameSite: 'Lax' },
          ])
        },
        state: async () => {
          const row = await db
            .selectFrom('auth.invitation')
            .select('status')
            .where('id', '=', invitation.id)
            .executeTakeFirstOrThrow()
          const membership = await db
            .selectFrom('auth.member as member')
            .innerJoin('auth.user as user', 'user.id', 'member.userId')
            .select('member.id')
            .where('member.organizationId', '=', team)
            .where('user.email', '=', email)
            .executeTakeFirst()
          const active = await db
            .selectFrom('auth.session as session')
            .innerJoin('auth.user as user', 'user.id', 'session.userId')
            .select('session.id')
            .where('user.email', '=', email)
            .where('session.activeOrganizationId', '=', team)
            .executeTakeFirst()
          return { status: row.status, joined: Boolean(membership), activeTeam: Boolean(active) }
        },
        expire: async () => {
          await db
            .updateTable('auth.invitation')
            .set({ expiresAt: new Date(Date.now() - 60_000) })
            .where('id', '=', invitation.id)
            .execute()
        },
      })
      expect(externalRequests, 'No actual third-party browser request is permitted').toBe(0)
    } finally {
      try {
        await listener?.close()
      } finally {
        try {
          await authPool?.end()
        } finally {
          await owned.drop()
          const verification = createPool(owned.url)
          try {
            let absent = false
            try {
              await verification.query('SELECT 1')
            } catch (error) {
              absent = (error as { code?: string }).code === '3D000'
            }
            expect(absent, 'The invitation database must be absent after teardown').toBe(true)
          } finally {
            await verification.end()
          }
          await listener?.assertClosed()
        }
      }
    }
  },
})
export { expect }
