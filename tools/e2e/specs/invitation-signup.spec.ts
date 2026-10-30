import type { Page } from '@playwright/test'
import { expect, type InvitationSignupApp, test } from '../invitation-signup-fixtures.ts'

const copy = {
  en: {
    signIn: 'Sign in to Hourmere',
    email: 'Email',
    send: 'Email me a sign-in link',
    sent: 'Check your email',
    space: /^Switch space/,
    join: 'Join team',
    invited: 'Invited email',
    signedIn: 'Signed in as',
    heading: 'Invitation to join Invitation signup team',
    unavailable: 'This invitation is unavailable.',
    guidance:
      'If you cannot sign in with the invited email, ask the team owner to check the invitation or contact this instance’s administrator about registration access.',
  },
  'zh-CN': {
    signIn: '登录 Hourmere',
    email: '邮箱',
    send: '通过邮件发送登录链接',
    sent: '查看邮件',
    space: /^切换空间/,
    join: '加入团队',
    invited: '受邀邮箱',
    signedIn: '当前登录账号',
    heading: '加入 Invitation signup team 的邀请',
    unavailable: '此邀请不可用。',
    guidance:
      '如果无法使用受邀邮箱登录，请联系团队所有者检查邀请，或联系此实例的管理员咨询注册权限。',
  },
} as const

function localPath(page: Page, origin: string, path: string) {
  const target = new URL(page.url())
  return target.origin === origin && target.pathname === path
}

async function prepareInvitation(
  page: Page,
  app: InvitationSignupApp,
  language: keyof typeof copy,
  existing: boolean,
) {
  const labels = copy[language]
  await page.goto(`${app.url}/sign-in`)
  await page
    .getByRole('combobox', { name: 'Interface language', exact: true })
    .selectOption(language)
  await page.getByRole('textbox', { name: labels.email, exact: true }).fill(app.ownerEmail)
  await page.getByRole('button', { name: labels.send, exact: true }).click()
  await expect(page.getByRole('heading', { name: labels.sent, exact: true })).toBeVisible()
  await expect.poll(() => Boolean(app.mailLink('sign-in', app.ownerEmail))).toBe(true)
  const ownerLink = app.mailLink('sign-in', app.ownerEmail)
  if (!ownerLink) throw new Error('The loopback mailbox did not receive the owner sign-in mail')
  await page.goto(ownerLink)
  await page.getByRole('button', { name: labels.signIn, exact: true }).click()
  await expect.poll(() => localPath(page, app.url, '/app/event-types')).toBe(true)
  await page.getByRole('button', { name: labels.space }).click()
  await page.getByRole('menuitemradio', { name: app.teamName, exact: true }).click()
  await expect(page.getByRole('button', { name: labels.space })).toContainText(app.teamName)

  expect(await app.state()).toMatchObject({
    accountExists: existing,
    signedIn: false,
    status: null,
    memberships: 0,
    activeTeam: false,
  })
  app.clearMailbox()
  // The current web app has no invitation form. Exercise the real public
  // invitation API using the owner's browser session, without pretending
  // this setup step establishes invite-form coverage.
  const created = await page.request.post(`${app.url}/api/auth/organization/invite-member`, {
    headers: { origin: app.url, 'X-Expected-Organization-Id': app.teamId },
    data: { email: app.recipientEmail, role: 'member', organizationId: app.teamId },
  })
  expect(created.status()).toBe(200)
  const result = (await created.json()) as { delivery: { state: string } }
  expect(result.delivery.state).toBe('queued')
  await expect
    .poll(() => app.state())
    .toMatchObject({ status: 'pending', queuedJobs: 1, memberships: 0, activeTeam: false })
  await expect.poll(() => Boolean(app.mailLink('invitation', app.recipientEmail))).toBe(true)
  await expect
    .poll(() => app.state())
    .toMatchObject({
      accountExists: existing,
      signedIn: false,
      status: 'pending',
      delivery: 'smtp_accepted',
      attempts: 1,
      memberships: 0,
      activeTeam: false,
    })
  const invitationLink = app.mailLink('invitation', app.recipientEmail)
  if (!invitationLink) throw new Error('The loopback mailbox did not receive the invitation')
  return invitationLink
}

for (const mode of ['closed', 'first-user'] as const) {
  for (const existing of [false, true]) {
    test.describe(`${mode} ${existing ? 'existing account' : 'new account'}`, () => {
      test.use({ signupMode: mode, existingRecipient: existing })
      for (const language of ['en', 'zh-CN'] as const) {
        test(`${language}: owner UI sign-in → invitation API → real SMTP mail → recipient UI sign-in → explicit join`, async ({
          page,
          context,
          invitationSignupApp: app,
        }) => {
          const labels = copy[language]
          const invitationLink = await prepareInvitation(page, app, language, existing)
          const invitationPath = new URL(invitationLink).pathname + new URL(invitationLink).search

          // The recipient starts unsigned in the same localized browser. No fixture
          // session cookies or authentication endpoint responses are fabricated.
          await context.clearCookies({ name: /better-auth/ })
          await page.goto(invitationLink)
          await expect(
            page.getByRole('heading', { name: labels.signIn, exact: true }),
          ).toBeVisible()
          expect(new URL(page.url()).searchParams.get('next') === invitationPath).toBe(true)
          expect(await page.locator('body').textContent()).not.toContain(app.recipientEmail)
          expect(await page.locator('body').textContent()).not.toContain(app.teamName)
          app.clearMailbox()
          await page
            .getByRole('textbox', { name: labels.email, exact: true })
            .fill(app.recipientEmail)
          await page.getByRole('button', { name: labels.send, exact: true }).click()
          await expect(page.getByRole('heading', { name: labels.sent, exact: true })).toBeVisible()
          await expect.poll(() => Boolean(app.mailLink('sign-in', app.recipientEmail))).toBe(true)
          // Requesting the link and delivering mail still must not create an account
          // or a team membership. Existing accounts remain independently signable in.
          expect(await app.state()).toMatchObject({
            accountExists: existing,
            signedIn: false,
            status: 'pending',
            memberships: 0,
            activeTeam: false,
          })
          const recipientLink = app.mailLink('sign-in', app.recipientEmail)
          if (!recipientLink)
            throw new Error('The loopback mailbox did not receive recipient sign-in mail')
          await page.goto(recipientLink)
          expect(await app.state()).toMatchObject({
            accountExists: existing,
            signedIn: false,
            memberships: 0,
          })
          await page.getByRole('button', { name: labels.signIn, exact: true }).click()
          await expect(
            page.getByRole('heading', { name: labels.heading, exact: true }),
          ).toBeVisible()
          await expect(page.getByText(labels.invited, { exact: false })).toContainText(
            app.recipientEmail,
          )
          await expect(page.getByText(labels.signedIn, { exact: false })).toContainText(
            app.recipientEmail,
          )
          expect(await app.state()).toMatchObject({
            accountExists: true,
            signedIn: true,
            status: 'pending',
            memberships: 0,
            activeTeam: false,
          })
          await page.reload()
          await expect(page.getByRole('button', { name: labels.join, exact: true })).toBeEnabled()
          expect(await app.state()).toMatchObject({
            status: 'pending',
            memberships: 0,
            activeTeam: false,
          })
          await page.getByRole('button', { name: labels.join, exact: true }).click()
          await expect.poll(() => localPath(page, app.url, '/app/event-types')).toBe(true)
          expect(await app.state()).toMatchObject({
            status: 'accepted',
            memberships: 1,
            activeTeam: true,
          })
          await page.goto(invitationLink)
          await expect(page.getByRole('alert')).toContainText(labels.unavailable)
          await expect(page.getByRole('button', { name: labels.join, exact: true })).toHaveCount(0)
          expect(await app.state()).toMatchObject({ status: 'accepted', memberships: 1 })
        })
      }
    })
  }
}

for (const language of ['en', 'zh-CN'] as const) {
  for (const source of ['different address', 'expired', 'canceled'] as const) {
    test(`${language}: ${source} gives the same mailbox acknowledgement and team-owner recovery without registration`, async ({
      page,
      context,
      invitationSignupApp: app,
    }) => {
      const labels = copy[language]
      const invitationLink = await prepareInvitation(page, app, language, false)
      if (source !== 'different address') await app.invalidate(source)
      const address =
        source === 'different address' ? 'different@hourmere.invalid' : app.recipientEmail
      await context.clearCookies({ name: /better-auth/ })
      await page.goto(invitationLink)
      await expect(page.getByRole('heading', { name: labels.signIn, exact: true })).toBeVisible()
      await expect(page.getByText(labels.guidance, { exact: true })).toBeVisible()
      expect(await page.locator('body').textContent()).not.toContain(app.recipientEmail)
      expect(await page.locator('body').textContent()).not.toContain(app.teamName)
      app.clearMailbox()
      const completed = await app.completedSignInJobs()
      await page.getByRole('textbox', { name: labels.email, exact: true }).fill(address)
      await page.getByRole('button', { name: labels.send, exact: true }).click()
      await expect(page.getByRole('heading', { name: labels.sent, exact: true })).toBeVisible()
      await expect(page.getByText(labels.guidance, { exact: true })).toBeVisible()
      await expect.poll(() => app.completedSignInJobs()).toBe(completed + 1)
      expect(Boolean(app.mailLink('sign-in', address))).toBe(false)
      expect(await app.accountExists(address)).toBe(false)
      expect(await app.state()).toMatchObject({
        accountExists: false,
        signedIn: false,
        memberships: 0,
        activeTeam: false,
      })
      await expect(page.getByRole('button', { name: labels.join, exact: true })).toHaveCount(0)
    })
  }
}
