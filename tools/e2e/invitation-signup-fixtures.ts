import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { RunningServer } from '../../apps/server/src/server.ts'
import { createDb } from '../../packages/db/src/index.ts'
import { createTestDatabase } from '../../packages/db/src/testing.ts'
import { fakeSmtpServer } from '../../packages/mail/src/smtp-testing.ts'
import { createFixtures } from '../../packages/scheduling/src/testing.ts'
import { startFixtureServer } from './fixture-server.ts'
import { test as base, expect } from './fixtures.ts'
import { listenOwned, type OwnedListener } from './listeners.ts'

interface InvitationSignupState {
  accountExists: boolean
  signedIn: boolean
  status: string | null
  delivery: string | null
  attempts: number
  queuedJobs: number
  memberships: number
  activeTeam: boolean
}

export interface InvitationSignupApp {
  url: string
  ownerEmail: string
  recipientEmail: string
  teamId: string
  teamName: string
  clearMailbox: () => void
  mailLink: (kind: 'invitation' | 'sign-in', email: string) => string | undefined
  state: () => Promise<InvitationSignupState>
  invalidate: (status: 'expired' | 'canceled') => Promise<void>
  accountExists: (email: string) => Promise<boolean>
  completedSignInJobs: () => Promise<number>
}

/** Read only the loopback SMTP sink's text body; never print its one-time links. */
function textBody(message: string): string {
  const plain = message.match(
    /Content-Type: text\/plain[^\r\n]*\r\n([\s\S]*?)\r\n\r\n([\s\S]*?)(?:\r\n--|$)/i,
  )
  if (!plain) throw new Error('SMTP mail must contain a plain-text body')
  const [, headers = '', body = ''] = plain
  if (/Content-Transfer-Encoding: base64/i.test(headers))
    return Buffer.from(body.replaceAll(/\s/g, ''), 'base64').toString('utf8')
  if (!/Content-Transfer-Encoding: quoted-printable/i.test(headers)) return body
  return body
    .replaceAll(/=\r\n/g, '')
    .replaceAll(/=([0-9A-F]{2})/gi, (_, byte: string) =>
      String.fromCharCode(Number.parseInt(byte, 16)),
    )
}

export const test = base.extend<{
  invitationSignupApp: InvitationSignupApp
  signupMode: 'closed' | 'first-user'
  existingRecipient: boolean
}>({
  signupMode: ['closed', { option: true }],
  existingRecipient: [false, { option: true }],
  invitationSignupApp: async ({ context, signupMode, existingRecipient }, use) => {
    const bootstrap = process.env.HOURMERE_E2E_BOOTSTRAP_URL
    if (!bootstrap) throw new Error('Invitation signup requires HOURMERE_E2E_BOOTSTRAP_URL')
    const owned = await createTestDatabase(bootstrap, undefined, { tag: 'invite_signup' })
    let app: RunningServer | undefined
    let listener: OwnedListener | undefined
    let smtpListener: OwnedListener | undefined
    let externalRequests = 0
    try {
      const db = createDb(owned.pool)
      const fixtures = createFixtures(db)
      const owner = await fixtures.host({ name: 'Inviting owner', handle: null })
      const ownerEmail = 'owner@hourmere.invalid'
      // Registration authority follows the real database ordering, independently of
      // team ownership. Make that ordering explicit before creating other accounts.
      await db
        .updateTable('auth.user')
        .set({ email: ownerEmail, createdAt: new Date('2020-01-01T00:00:00Z') })
        .where('id', '=', owner.userId)
        .execute()
      const recipientEmail = 'recipient@hourmere.invalid'
      if (existingRecipient) {
        const recipient = await fixtures.host({ name: 'Existing recipient', handle: null })
        await db
          .updateTable('auth.user')
          .set({ email: recipientEmail, createdAt: new Date('2021-01-01T00:00:00Z') })
          .where('id', '=', recipient.userId)
          .execute()
      }
      const first = await db
        .selectFrom('auth.user')
        .select('id')
        .orderBy('createdAt')
        .orderBy('id')
        .executeTakeFirstOrThrow()
      expect(first.id === owner.userId, 'The inviter must really be the instance first user').toBe(
        true,
      )
      const teamName = 'Invitation signup team'
      const teamId = await fixtures.organization(teamName)
      await fixtures.member(owner.userId, teamId, 'owner')
      const smtp = fakeSmtpServer()
      smtpListener = await listenOwned(smtp.server)
      listener = await listenOwned(createServer({ allowHalfOpen: true }))
      const { url } = listener
      app = await startFixtureServer(listener, {
        DATABASE_URL: owned.url,
        BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
        SIGNUP: signupMode,
        SIGNUP_ALLOWED_DOMAINS: '',
        HOURMERE_ROLE: 'all',
        AUTO_MIGRATE: 'true',
        SMTP_URL: `smtp://127.0.0.1:${smtpListener.port}`,
        MAIL_FROM: 'Hourmere <sender@hourmere.invalid>',
        WEB_DIST:
          process.env.HOURMERE_E2E_WEB_DIST ??
          fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
      })
      await context.route('**/*', async (route) => {
        if (new URL(route.request().url()).origin === url) return route.continue()
        externalRequests++
        return route.abort('blockedbyclient')
      })
      await use({
        url,
        ownerEmail,
        recipientEmail,
        teamId,
        teamName,
        clearMailbox: () => {
          smtp.received.data = undefined
          smtp.received.to.length = 0
        },
        mailLink: (kind, email) => {
          if (
            !smtp.received.data ||
            !smtp.received.to.some((recipient) => recipient.includes(`<${email}>`))
          )
            return undefined
          const link = textBody(smtp.received.data).match(/https?:\/\/[^\s<>]+/)?.[0]
          if (!link) return undefined
          const target = new URL(link)
          const expected = kind === 'invitation' ? '/app/join' : '/sign-in/confirm'
          if (target.origin !== url || target.pathname !== expected) return undefined
          return target.href
        },
        state: async () => {
          const user = await db
            .selectFrom('auth.user')
            .select('id')
            .where('email', '=', recipientEmail)
            .executeTakeFirst()
          const invitation = await db
            .selectFrom('auth.invitation')
            .select(['id', 'status'])
            .where('organizationId', '=', teamId)
            .where('email', '=', recipientEmail)
            .executeTakeFirst()
          const delivery = invitation
            ? await db
                .selectFrom('invitation_deliveries')
                .select(['state', 'attempts'])
                .where('invitation_id', '=', invitation.id)
                .executeTakeFirst()
            : undefined
          const jobs = invitation
            ? await owned.pool.query<{ count: string }>(
                "SELECT count(*) FROM pgboss.job WHERE name = 'invitation-email-v1' AND data ->> 'invitationId' = $1",
                [invitation.id],
              )
            : undefined
          const memberships = user
            ? await db
                .selectFrom('auth.member')
                .select('id')
                .where('organizationId', '=', teamId)
                .where('userId', '=', user.id)
                .execute()
            : []
          const sessions = user
            ? await db
                .selectFrom('auth.session')
                .select('activeOrganizationId')
                .where('userId', '=', user.id)
                .execute()
            : []
          return {
            accountExists: Boolean(user),
            signedIn: sessions.length > 0,
            status: invitation?.status ?? null,
            delivery: delivery?.state ?? null,
            attempts: delivery?.attempts ?? 0,
            queuedJobs: Number(jobs?.rows[0]?.count ?? 0),
            memberships: memberships.length,
            activeTeam: sessions.some((session) => session.activeOrganizationId === teamId),
          }
        },
        invalidate: async (status) => {
          await db
            .updateTable('auth.invitation')
            .set(
              status === 'expired'
                ? { expiresAt: new Date(Date.now() - 60_000) }
                : { status: 'canceled' },
            )
            .where('organizationId', '=', teamId)
            .where('email', '=', recipientEmail)
            .execute()
        },
        accountExists: async (email) =>
          Boolean(
            await db
              .selectFrom('auth.user')
              .select('id')
              .where('email', '=', email)
              .executeTakeFirst(),
          ),
        completedSignInJobs: async () => {
          const result = await owned.pool.query<{ count: string }>(
            "SELECT count(*) FROM pgboss.job WHERE name = 'sign-in-email' AND state = 'completed'",
          )
          return Number(result.rows[0]?.count ?? 0)
        },
      })
      expect(externalRequests, 'No third-party browser request is permitted').toBe(0)
    } finally {
      try {
        await app?.close()
      } finally {
        try {
          await listener?.close()
        } finally {
          try {
            await smtpListener?.close()
          } finally {
            await owned.drop()
            await listener?.assertClosed()
            await smtpListener?.assertClosed()
          }
        }
      }
    }
  },
})
export { expect }
