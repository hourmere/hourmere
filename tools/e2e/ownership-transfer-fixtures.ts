// Install the OpenAPI extensions before loading route schemas.
import '@hono/zod-openapi'
import { createHmac, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { getRequestListener } from '@hono/node-server'
import { createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { LANGUAGE_COOKIE } from '@hourmere/core/language'
import { createDb } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import type { BrowserContext, Locator } from '@playwright/test'
import { sql } from 'kysely'
import { createApp } from '../../apps/server/src/app.ts'
import { ownershipTransferNoticeJob } from '../../apps/server/src/ownership-transfer-notices.ts'
import { productRoutes } from '../../apps/server/src/server.ts'
import {
  deliverMailboxProof,
  MAILBOX_PROOF_CONFIRM_PATH,
  MailboxProofEmailPayload,
  mailboxProofRoutes,
} from '../../apps/server/src/sso-mailbox-proof.ts'
import { test as base, expect } from './fixtures.ts'
import { fillPrivate } from './keycloak/browser.ts'
import { listenOwned, type OwnedListener } from './listeners.ts'

export { expect }

export const ownerName = 'Transfer Owner'
export const recipientName = 'Transfer Recipient'
type Actor = 'owner' | 'recipient'
type Language = 'en' | 'zh-CN'

interface TransferApp {
  url: string
  teamId: string
  path: string
  apiPath: string
  signIn: (context: BrowserContext, actor: Actor, language: Language) => Promise<void>
  pasteMailboxLink: (actor: Actor, field: Locator) => Promise<void>
  roles: () => Promise<Record<Actor, string | null>>
  seedOffer: () => Promise<string>
  expireOffer: (id: string) => Promise<void>
  transferState: (id: string) => Promise<string>
}

export const test = base.extend<{ transfer: TransferApp }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring.
  transfer: async ({}, use) => {
    const bootstrap = process.env.HOURMERE_E2E_BOOTSTRAP_URL
    if (!bootstrap) throw new Error('HOURMERE_E2E_BOOTSTRAP_URL must bootstrap the test database')
    const owned = await createTestDatabase(bootstrap, undefined, { tag: 'transfer_browser' })
    let listener: OwnedListener | undefined
    let authPool: ReturnType<typeof createAuthPool> | undefined
    let stopJobs: (() => Promise<void>) | undefined
    try {
      listener = await listenOwned(createServer())
      const { url } = listener
      const db = createDb(owned.pool)
      const users = {
        owner: await createTestUser(db, ownerName),
        recipient: await createTestUser(db, recipientName),
      }
      const team = await createTestTeam(
        db,
        [
          { user: users.owner, role: 'owner' },
          { user: users.recipient, role: 'member' },
        ],
        'Transfer Test Team',
      )
      const members = await db
        .selectFrom('auth.member')
        .select(['id', 'userId'])
        .where('organizationId', '=', team.id)
        .execute()
      const initiator = members.find(({ userId }) => userId === users.owner.id)
      const recipient = members.find(({ userId }) => userId === users.recipient.id)
      if (!initiator || !recipient) throw new Error('Expected two transfer memberships')

      // Run the proof worker against Postgres and capture its mail in memory.
      const signup = { mode: 'closed', allowedDomains: [] } as const
      const secret = randomBytes(32).toString('base64')
      const capabilities = { ssoOidcEnabled: false, ssoSamlEnabled: false }
      const queued: MailboxProofEmailPayload[] = []
      const mailer = {
        send: async () => {
          throw new Error('Direct outbound mail is disabled in this fixture')
        },
      }
      authPool = createAuthPool(owned.url, signup)
      const notificationQueue = createJobs({
        connectionString: owned.url,
        definitions: [ownershipTransferNoticeJob({ db, publicUrl: url, mailer })],
        work: false,
        migrate: true,
        maxConnections: 2,
        log: () => {},
      })
      stopJobs = () => notificationQueue.stop()
      await notificationQueue.start()
      const auth = createAuth({ pool: authPool, db, baseURL: url, secret, signup, mailer })
      const app = createApp({
        publicUrl: url,
        checkDb: async () => {},
        authHandler: auth.handler,
        resolveCaller: createCallerResolver({ auth, db }),
        webDist:
          process.env.HOURMERE_E2E_WEB_DIST ??
          fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
        ssoMailboxProof: mailboxProofRoutes({
          db,
          capabilities,
          ownershipTransferEnabled: true,
          queue: {
            async enqueue(_name, payload) {
              queued.push(MailboxProofEmailPayload.parse(payload))
              return 'fixture-mailbox-proof'
            },
          },
        }),
        routes: productRoutes({
          db,
          publicUrl: url,
          socialProviders: {},
          invitationMailLimits: { secret },
          notify: async () => {},
          ownershipTransfer: { db, publicUrl: url, capabilities, notificationQueue },
        }),
      })
      listener.server.on('request', getRequestListener(app.fetch, { hostname: '127.0.0.1' }))

      let externalRequests = 0
      await use({
        url,
        teamId: team.id,
        path: '/app/settings#team-members',
        apiPath: `/api/v1/teams/${team.id}/ownership-transfer`,
        async signIn(context, actor, language) {
          const user = users[actor]
          const token = randomBytes(32).toString('base64url')
          await db
            .insertInto('auth.session')
            .values({
              token,
              userId: user.id,
              activeOrganizationId: team.id,
              expiresAt: sql`clock_timestamp() + interval '1 hour'`,
              updatedAt: sql`clock_timestamp()`,
            })
            .execute()
          await db
            .insertInto('profiles')
            .values({
              user_id: user.id,
              handle: `transfer-${actor}`,
              locale: language,
              time_zone: 'UTC',
            })
            .execute()
          const signature = createHmac('sha256', secret).update(token).digest('base64')
          await context.addCookies([
            {
              name: 'better-auth.session_token',
              value: encodeURIComponent(`${token}.${signature}`),
              url,
              httpOnly: true,
              sameSite: 'Lax',
            },
            { name: LANGUAGE_COOKIE, value: language, url },
          ])
          await context.route('**/*', (route) => {
            if (new URL(route.request().url()).origin === url) return route.continue()
            externalRequests++
            return route.abort('blockedbyclient')
          })
        },
        async pasteMailboxLink(actor, field) {
          let link: string | undefined
          const prefix = new URL(MAILBOX_PROOF_CONFIRM_PATH, url).href
          for (const payload of queued.splice(0)) {
            await deliverMailboxProof(
              {
                db,
                capabilities,
                ownershipTransferEnabled: true,
                publicUrl: url,
                secret,
                mailer: {
                  async send({ to, text }) {
                    if (to === users[actor].email)
                      link = text?.split('\n').find((line) => line.startsWith(`${prefix}#`))
                  },
                },
              },
              payload,
            )
          }
          if (!link) throw new Error('No verification link for the expected fixture account')
          await fillPrivate(field, link)
        },
        async roles() {
          const rows = await db
            .selectFrom('auth.member')
            .select(['id', 'role'])
            .where('id', 'in', [initiator.id, recipient.id])
            .execute()
          return {
            owner: rows.find(({ id }) => id === initiator.id)?.role ?? null,
            recipient: rows.find(({ id }) => id === recipient.id)?.role ?? null,
          }
        },
        async seedOffer() {
          const { id } = await db
            .insertInto('organization_ownership_transfers')
            .values({
              organization_id: team.id,
              initiator_user_id: users.owner.id,
              initiator_membership_id: initiator.id,
              target_user_id: users.recipient.id,
              target_membership_id: recipient.id,
              created_at: sql`clock_timestamp()`,
              expires_at: sql`clock_timestamp() + interval '24 hours'`,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
          return id
        },
        async expireOffer(id) {
          // Backdate the fixture by 24 hours without changing the schema or server clock.
          await db.transaction().execute(async (trx) => {
            await sql`SET LOCAL session_replication_role = replica`.execute(trx)
            await sql`
                  WITH deadline AS (SELECT clock_timestamp() - interval '1 second' AS instant)
                  UPDATE organization_ownership_transfers
                  SET created_at = deadline.instant - interval '24 hours', expires_at = deadline.instant
                  FROM deadline WHERE id = ${id}::uuid AND state = 'pending'
                `.execute(trx)
          })
        },
        async transferState(id) {
          const { state } = await db
            .selectFrom('organization_ownership_transfers')
            .select('state')
            .where('id', '=', id)
            .executeTakeFirstOrThrow()
          return state
        },
      })
      expect(externalRequests).toBe(0)
    } finally {
      try {
        await listener?.close()
      } finally {
        try {
          await stopJobs?.()
        } finally {
          try {
            await authPool?.end()
          } finally {
            await owned.drop()
          }
        }
      }
    }
  },
})
