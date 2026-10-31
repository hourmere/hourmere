import type { Page } from '@playwright/test'
import { expect, type InvitationSignupApp, test } from '../invitation-signup-fixtures.ts'

const copy = {
  en: {
    signIn: 'Sign in to Hourmere',
    email: 'Email',
    send: 'Email me a sign-in link',
    sent: 'Check your email',
    eventTypes: 'Event types',
    space: /^Switch space/,
    invite: 'Invite member',
    queued: 'Invitation queued for delivery.',
    pending: 'Pending invitations',
    waiting: 'Waiting to send',
    invitation: (email: string) => `Invitation to ${email}`,
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
    eventTypes: '活动类型',
    space: /^切换空间/,
    invite: '邀请成员',
    queued: '邀请已加入投递队列。',
    pending: '待接受的邀请',
    waiting: '等待发送',
    invitation: (email: string) => `发给 ${email} 的邀请`,
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
  // The /app redirect focuses main after navigation; finish it before opening a menu.
  await expect(page.locator('main#main')).toBeFocused()
  await expect(page.getByRole('heading', { name: labels.eventTypes, exact: true })).toBeVisible()
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
  await page.goto(`${app.url}/app/settings`)
  const form = page.getByRole('region', { name: labels.invite, exact: true })
  await form.getByRole('textbox', { name: labels.email, exact: true }).fill(app.recipientEmail)
  const queued = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/auth/organization/invite-member',
  )
  await form.getByRole('button', { name: labels.invite, exact: true }).click()
  const created = await queued
  expect(created.status()).toBe(200)
  expect(created.request().headers()['x-expected-organization-id']).toBe(app.teamId)
  const result = (await created.json()) as { role: string; delivery: { state: string } }
  expect(result.role).toBe('member')
  expect(result.delivery.state).toBe('queued')
  await expect(form.getByRole('status')).toHaveText(labels.queued)
  const pending = page.getByRole('region', { name: labels.pending, exact: true })
  const invitation = pending.getByRole('listitem').filter({
    has: page.getByRole('heading', { name: labels.invitation(app.recipientEmail), exact: true }),
  })
  await expect(invitation.getByText(labels.waiting, { exact: true })).toBeVisible()
  await expect
    .poll(() => app.state())
    .toMatchObject({
      status: 'pending',
      delivery: 'queued',
      attempts: 0,
      queuedJobs: 1,
      memberships: 0,
      activeTeam: false,
    })
  await app.startInvitationDelivery()
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
        test(`${language}: owner UI sign-in → invite form → queued pending invitation → real SMTP mail → recipient UI sign-in → explicit join`, async ({
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
    test(`${language}: ${source} gives the same mailbox acknowledgement and administrator recovery without registration`, async ({
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
