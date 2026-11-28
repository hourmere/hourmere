import { createHmac, randomBytes } from 'node:crypto'
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
import { smtpTextBody } from './smtp-text-body.ts'

type Actor = 'owner' | 'admin' | 'member'

interface CustomRolesFixture {
  url: string
  teamId: string
  memberId: string
  signIn: (actor: Actor, locale: 'en' | 'zh-CN') => Promise<void>
  proofLink: (index: number) => Promise<string>
  seedTeamEvent: (title: string) => Promise<string>
  grantMemberPermissions: (permissionIds: string[]) => Promise<void>
  promoteMemberToAdmin: () => Promise<void>
}

export const test = base.extend<{ roles: CustomRolesFixture; customRoleRuntime: boolean }>({
  customRoleRuntime: [true, { option: true }],
  roles: async ({ context, customRoleRuntime }, use) => {
    const bootstrap = process.env.HOURMERE_E2E_BOOTSTRAP_URL
    if (!bootstrap) throw new Error('Custom roles require HOURMERE_E2E_BOOTSTRAP_URL')
    const owned = await createTestDatabase(bootstrap, undefined, { tag: 'custom_roles' })
    let listener: OwnedListener | undefined
    let smtpListener: OwnedListener | undefined
    let app: RunningServer | undefined
    try {
      const db = createDb(owned.pool)
      const fixture = createFixtures(db)
      const actors = {
        owner: await fixture.host({ name: 'Fixture Owner' }),
        admin: await fixture.host({ name: 'Fixture Admin' }),
        member: await fixture.host({ name: 'Fixture Member' }),
      }
      const teamId = await fixture.organization('fixture-role-team')
      for (const [role, { userId }] of Object.entries(actors)) {
        await fixture.member(userId, teamId, role)
      }
      const { id: memberId } = await db
        .selectFrom('auth.member')
        .select('id')
        .where('organizationId', '=', teamId)
        .where('userId', '=', actors.member.userId)
        .executeTakeFirstOrThrow()
      if (customRoleRuntime) {
        await db
          .updateTable('custom_role_master_policy')
          .set({ enabled: true, policy_epoch: 1 })
          .executeTakeFirstOrThrow()
      }
      const smtp = fakeSmtpServer()
      smtpListener = await listenOwned(smtp.server)
      listener = await listenOwned(createServer({ allowHalfOpen: true }))
      const { url } = listener
      const secret = randomBytes(32).toString('base64url')
      app = await startFixtureServer(
        listener,
        {
          DATABASE_URL: owned.url,
          BETTER_AUTH_SECRET: secret,
          SIGNUP: 'closed',
          HOURMERE_ROLE: 'all',
          SSO_OIDC_ENABLED: 'false',
          SSO_SAML_ENABLED: 'false',
          SMTP_URL: `smtp://127.0.0.1:${smtpListener.port}`,
          MAIL_FROM: 'Hourmere Fixture <fixture@hourmere.invalid>',
          WEB_DIST:
            process.env.HOURMERE_E2E_WEB_DIST ??
            fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
        },
        undefined,
        { customRolesEnabled: customRoleRuntime },
      )
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === url
          ? route.continue()
          : route.abort('blockedbyclient'),
      )

      const sessions = new Map<Actor, string>()
      await use({
        url,
        teamId,
        memberId,
        seedTeamEvent: (title) =>
          fixture.eventType(teamId, null, {
            title,
            hosts: [{ userId: actors.owner.userId }],
          }),
        grantMemberPermissions: (permissionIds) =>
          db.transaction().execute(async (trx) => {
            await trx
              .updateTable('team_custom_role_policies')
              .set({ enabled: true, policy_epoch: 1 })
              .where('organization_id', '=', teamId)
              .executeTakeFirstOrThrow()
            const { id: roleId } = await trx
              .insertInto('custom_roles')
              .values({ organization_id: teamId, active_revision: 1 })
              .returning('id')
              .executeTakeFirstOrThrow()
            await trx
              .insertInto('custom_role_revisions')
              .values({
                organization_id: teamId,
                role_id: roleId,
                revision: 1,
                name: 'Scheduling coordinator',
                permission_ids: permissionIds,
              })
              .execute()
            await trx
              .insertInto('custom_role_assignments')
              .values({
                organization_id: teamId,
                member_id: memberId,
                user_id: actors.member.userId,
                role_id: roleId,
                assigned_by_user_id: actors.owner.userId,
              })
              .execute()
          }),
        promoteMemberToAdmin: async () => {
          // The normal membership trigger clears the role and advances authorization.
          await db
            .updateTable('auth.member')
            .set({ role: 'admin' })
            .where('id', '=', memberId)
            .execute()
        },
        signIn: async (actor, locale) => {
          const { userId } = actors[actor]
          await db.updateTable('profiles').set({ locale }).where('user_id', '=', userId).execute()
          let token = sessions.get(actor)
          if (!token) {
            token = randomBytes(24).toString('base64url')
            await db
              .insertInto('auth.session')
              .values({
                userId,
                activeOrganizationId: teamId,
                token,
                updatedAt: new Date(),
                expiresAt: new Date(Date.now() + 3_600_000),
              })
              .execute()
            sessions.set(actor, token)
          }
          await context.addCookies([
            {
              name: 'better-auth.session_token',
              value: encodeURIComponent(
                `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`,
              ),
              url,
              httpOnly: true,
              sameSite: 'Lax',
            },
          ])
        },
        proofLink: async (index) => {
          await expect.poll(() => smtp.received.messages.length).toBeGreaterThan(index)
          const message = smtp.received.messages[index]
          if (message === undefined) throw new Error('Missing verification email')
          const prefix = `${url}/app/mailbox-proof#`
          const link = smtpTextBody(message)
            .split(/\r?\n/u)
            .find((line) => line.startsWith(prefix))
          if (!link) throw new Error('Missing verification link in the loopback email')
          return link
        },
      })
    } finally {
      try {
        await app?.close()
        await listener?.close()
        await smtpListener?.close()
      } finally {
        await owned.drop()
      }
    }
  },
})

export { expect }
