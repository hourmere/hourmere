import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Page } from '@playwright/test'
import { sql } from 'kysely'
import {
  button,
  clickPrivate,
  expectSession,
  fillPrivate,
  proveMailbox,
  returnPath,
  signInAtKeycloak,
  signInUrl,
  signInWithEmail,
  signOut,
  submitKeycloakLogin,
} from '../keycloak/browser.ts'
import { expect, type KeycloakFixture, test } from '../keycloak/fixture.ts'

const recoveryPath = '/app/settings/sso/recovery'
const providerName = 'Fixture Keycloak'
const execute = promisify(execFile)
const recoveryCommand = fileURLToPath(
  new URL('../../../apps/server/src/sso-operator-recovery-cli.ts', import.meta.url),
)

test.use({ enforced: true })

async function openMailboxSession(page: Page, app: KeycloakFixture) {
  await page.goto(`${app.url}/sign-in`)
  await signInWithEmail(page, app, app.idp.linked.email)
  await expectSession(page, app, app.linkedUserId, true)
}

async function expectTeamDataDenied(page: Page, app: KeycloakFixture) {
  const response = await page.request.get(
    `${app.url}/api/auth/organization/get-full-organization`,
    {
      params: { organizationId: app.teamId },
    },
  )
  expect(response.status()).toBe(403)
  expect(await response.json()).toEqual({ code: 'SSO_REQUIRED', message: 'sso_required' })
}

function providerPath(app: KeycloakFixture) {
  return `${app.url}/api/v1/team/sso/providers/${app.providerId}`
}

async function recoverByEmail(page: Page, app: KeycloakFixture, label: string) {
  const [challenge] = await Promise.all([
    page.waitForResponse(`${app.url}/api/v1/team/sso/recovery/use`),
    button(page, label).click(),
  ])
  expect(challenge.status()).toBe(403)
  const { error, proofMethods } = await challenge.json()
  expect({ error, proofMethods }).toEqual({
    error: 'sso_reauthentication_required',
    proofMethods: ['mailbox'],
  })
  await proveMailbox(page, app, app.idp.linked.email)
  await button(page, 'Continue').click()
  await expect(page.getByRole('heading', { name: 'Repair identity providers' })).toBeVisible()
}

async function expectRecoveryWriteDenied(
  page: Page,
  app: KeycloakFixture,
  operation: 'test' | 'activation',
  body: { expectedRevision: number; enabled?: boolean },
) {
  const response = await page.request.post(`${providerPath(app)}/${operation}`, {
    headers: { Origin: app.url, 'X-Expected-Organization-Id': app.teamId },
    data: body,
  })
  expect(response.status()).toBe(403)
  expect(await response.json()).toEqual({ error: 'team_management_access_denied' })
}

test.describe('break-glass provider repair', () => {
  test.use({ brokenProvider: true })

  test('a mailbox recovery owner spends a separate ceremony on each Keycloak repair write', async ({
    page,
    context,
    keycloak: app,
  }) => {
    await app.db.transaction().execute(async (db) => {
      await db
        .updateTable('auth.member')
        .set({ role: 'owner' })
        .where('organizationId', '=', app.teamId)
        .where('userId', '=', app.linkableUserId)
        .execute()
      const owner = await db
        .selectFrom('auth.member')
        .select('id')
        .where('organizationId', '=', app.teamId)
        .where('userId', '=', app.linkedUserId)
        .executeTakeFirstOrThrow()
      await db
        .insertInto('sso_recovery_owners')
        .values({
          organization_id: app.teamId,
          member_id: owner.id,
          user_id: app.linkedUserId,
          nominated_by_user_id: app.linkableUserId,
        })
        .execute()
    })

    await openMailboxSession(page, app)
    await expectTeamDataDenied(page, app)
    await expectRecoveryWriteDenied(page, app, 'test', { expectedRevision: 1 })
    await page.goto(`${app.url}${recoveryPath}`)
    await expect(
      page.getByRole('heading', { name: `SSO recovery for ${app.teamName}`, exact: true }),
    ).toBeVisible()

    await recoverByEmail(page, app, 'Start recovery')
    await expectTeamDataDenied(page, app)
    await expect(page.getByText('Revision 1 · Disabled', { exact: true })).toBeVisible()
    await button(page, `Edit ${providerName}`).click()
    await button(page, 'Replace client secret').click()
    await fillPrivate(page.getByLabel('New client secret', { exact: true }), app.idp.clientSecret)
    await clickPrivate(button(page, 'Save changes'))
    await expect(
      page.getByText('Provider saved. Verify again to test the current revision.', { exact: true }),
    ).toBeVisible()
    await expectRecoveryWriteDenied(page, app, 'test', { expectedRevision: 2 })

    await recoverByEmail(page, app, 'Verify again to continue recovery')
    await expect(page.getByText('Revision 2 · Disabled', { exact: true })).toBeVisible()
    await expect(button(page, `Enable provider ${providerName}`)).toBeDisabled()
    await clickPrivate(button(page, `Test provider ${providerName}`))
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      clickPrivate(
        page.getByRole('link', { name: 'Continue to identity provider (opens in a new tab)' }),
      ),
    ])
    try {
      await submitKeycloakLogin(popup, app, app.idp.linked.username)
      await expect.poll(() => popup.url() === `${app.url}/app/settings`).toBe(true)
    } finally {
      await popup.close()
    }
    expect(app.tokenExchanges()).toEqual(['issued'])
    await expectRecoveryWriteDenied(page, app, 'activation', { expectedRevision: 2, enabled: true })

    await recoverByEmail(page, app, 'Verify again to continue recovery')
    await expect(page.getByText('Current revision passed its test.', { exact: true })).toBeVisible()
    await button(page, `Enable provider ${providerName}`).click()
    await expect(
      page.getByText('The current provider revision is enabled.', { exact: true }),
    ).toBeVisible()
    await expectTeamDataDenied(page, app)

    await signOut(page, app)
    await context.clearCookies()
    await page.goto(signInUrl(app))
    await signInAtKeycloak(page, app)
    await expectSession(page, app, app.linkedUserId, false)
    expect(app.tokenExchanges()).toEqual(['issued', 'issued'])
  })
})

async function runOperatorRecovery(app: KeycloakFixture) {
  try {
    // The fixture emulates the server container guard with its disposable database only.
    const { stdout } = await execute(process.execPath, [recoveryCommand, app.teamId], {
      env: { DATABASE_URL: app.databaseUrl, HOURMERE_SERVER_CONTAINER: '1' },
    })
    return stdout.trim()
  } catch {
    throw new Error('The fixture operator recovery command failed')
  }
}

test.describe('', () => {
  test.use({ dedicatedKeycloak: true })

  test('operator recovery restores browser access to only the target team during a Keycloak outage', async ({
    page,
    keycloak: app,
  }) => {
    const { id: otherTeam } = await app.db
      .insertInto('auth.organization')
      .values({ slug: 'unaffected-team', name: 'Unaffected team', createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    await app.db
      .insertInto('sso_policies')
      .values({ organization_id: otherTeam, require_sso: true })
      .execute()
    const { ssoOperatorRecoveryQueue } = await import(
      '../../../apps/server/src/sso-operator-recovery.ts'
    )
    const { createJobs } = await import('../../../packages/jobs/src/index.ts')
    const queue = createJobs({
      connectionString: app.databaseUrl,
      definitions: [ssoOperatorRecoveryQueue],
      migrate: true,
      work: false,
      log: () => {},
    })
    try {
      await queue.start()
    } finally {
      await queue.stop()
    }
    const policies = () =>
      app.db.selectFrom('sso_policies').selectAll().orderBy('organization_id').execute()
    const before = await policies()

    await app.idp.stop()
    await openMailboxSession(page, app)
    await expectTeamDataDenied(page, app)
    expect(await runOperatorRecovery(app)).toBe(
      'SSO enforcement disabled. Owner notifications queued.',
    )
    expect(await policies()).toEqual(
      before.map((row) =>
        row.organization_id === app.teamId
          ? {
              ...row,
              require_sso: false,
              policy_revision: row.policy_revision + 1,
              trust_generation: row.trust_generation + 1,
            }
          : row,
      ),
    )

    await page.goto(`${app.url}${returnPath}`)
    const space = page.getByRole('button', { name: /^Switch space/ })
    await space.click()
    await page.getByRole('menuitemradio', { name: app.teamName, exact: true }).click()
    await expect(space).toContainText(app.teamName)
    await expectSession(page, app, app.linkedUserId, false)

    expect(await runOperatorRecovery(app)).toBe('SSO enforcement is already off. No changes made.')
    const events = await app.db
      .selectFrom('audit_events')
      .select(['organization_id', 'actor_type', 'target_id'])
      .where('action', '=', 'sso_maintenance.enforcement_disabled')
      .execute()
    expect(events).toEqual([
      { organization_id: app.teamId, actor_type: 'system', target_id: app.teamId },
    ])
    const { rows } = await sql<{ organizationId: string; userId: string }>`
      select data->>'organizationId' as "organizationId", data->>'userId' as "userId"
      from pgboss.job where name = ${ssoOperatorRecoveryQueue.name}
    `.execute(app.db)
    expect(rows).toEqual([{ organizationId: app.teamId, userId: app.linkedUserId }])
  })
})
