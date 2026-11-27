import type { Page } from '@playwright/test'
import { button, expectSession, proveMailbox, signInWithEmail } from './browser.ts'
import { expect, type KeycloakFixture } from './fixture.ts'

export const providerName = 'Fixture Keycloak'

export async function seedRecoveryOwner(app: KeycloakFixture) {
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
}

export async function openMailboxSession(page: Page, app: KeycloakFixture) {
  await page.goto(`${app.url}/sign-in`)
  await signInWithEmail(page, app, app.idp.linked.email)
  await expectSession(page, app, app.linkedUserId, true)
}

export async function expectTeamDataDenied(page: Page, app: KeycloakFixture) {
  const response = await page.request
    .get(`${app.url}/api/auth/organization/get-full-organization`, {
      params: { organizationId: app.teamId },
    })
    .catch(() => {
      throw new Error('The browser could not read the fixture team')
    })
  expect(response.status()).toBe(403)
  expect(await response.json()).toEqual({ code: 'SSO_REQUIRED', message: 'sso_required' })
}

export async function openRecoveryPage(page: Page, app: KeycloakFixture) {
  await page.goto(`${app.url}/app/settings/sso/recovery`)
  await expect(
    page.getByRole('heading', { name: `SSO recovery for ${app.teamName}`, exact: true }),
  ).toBeVisible()
}

export async function recoverByEmail(page: Page, app: KeycloakFixture, label = 'Start recovery') {
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
