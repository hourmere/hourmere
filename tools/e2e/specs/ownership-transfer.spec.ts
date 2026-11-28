import type { Locator, Page, Route } from '@playwright/test'
import { scanA11y } from '../a11y.ts'
import { clickPrivate } from '../keycloak/browser.ts'
import { expect, ownerName, recipientName, test } from '../ownership-transfer-fixtures.ts'

const labels = {
  en: {
    region: 'Team ownership transfer',
    roster: 'Team members',
    offer: `Offer ownership to ${recipientName}`,
    review: 'Review ownership transfer',
    send: 'Send transfer offer',
    accept: 'Accept ownership',
    decline: 'Decline transfer',
    revoke: 'Revoke transfer',
    refresh: 'Refresh transfer status',
    pending: 'Transfer offer pending.',
    completed: 'Ownership transfer completed.',
    declined: 'You declined the transfer offer.',
    revoked: 'The transfer offer was revoked or declined.',
    expired: 'The transfer offer expired.',
    invalidated: 'The transfer offer is no longer valid.',
    admin: 'Admin',
    owner: 'Owner',
    originalRole: `${ownerName} will become an admin.`,
    ownRole: 'You will become an admin when the recipient accepts.',
    newRole: `${recipientName} will become the team owner.`,
    boundary:
      'Personal spaces, calendars and provider connections stay with their current accounts. API keys and agent authorizations are not transferred.',
    sendMail: 'Send verification email',
    mailLink: 'Email verification link',
    verify: 'Verify email link',
    verified: 'Email verification complete.',
    continue: 'Continue',
  },
  'zh-CN': {
    region: '团队所有权转移',
    roster: '团队成员',
    offer: `向 ${recipientName} 发出所有权转移提议`,
    review: '核对所有权转移',
    send: '发送转移提议',
    accept: '接受所有权',
    decline: '拒绝转移',
    revoke: '撤回转移',
    refresh: '刷新转移状态',
    pending: '转移提议待处理。',
    completed: '所有权转移已完成。',
    declined: '你已拒绝转移提议。',
    revoked: '转移提议已撤回或被拒绝。',
    expired: '转移提议已过期。',
    invalidated: '转移提议已失效。',
    admin: '管理员',
    owner: '所有者',
    originalRole: `${ownerName} 将成为管理员。`,
    ownRole: '收件人接受后，你将成为管理员。',
    newRole: `${recipientName} 将成为团队所有者。`,
    boundary: '个人空间、日历和服务商连接仍归当前账户所有。API 密钥和代理授权不会转移。',
    sendMail: '发送验证邮件',
    mailLink: '邮箱验证链接',
    verify: '验证邮箱链接',
    verified: '邮箱验证已完成。',
    continue: '继续',
  },
}

type Labels = (typeof labels)[keyof typeof labels]
const originalRoles = { owner: 'owner', recipient: 'member' }
const transferredRoles = { owner: 'admin', recipient: 'owner' }

function button(scope: Page | Locator, name: string) {
  return scope.getByRole('button', { name, exact: true })
}

function panel(page: Page, text: Labels) {
  return page.getByRole('region', { name: text.region, exact: true })
}

function transferResponse(page: Page, pathname: string) {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === pathname && response.request().method() === 'POST',
  )
}

async function proveMailbox(
  scope: Locator,
  text: Labels,
  pasteLink: (field: Locator) => Promise<void>,
) {
  const submit = button(scope, text.continue)
  await expect(submit).toBeDisabled()
  await button(scope, text.sendMail).click()
  const input = scope.getByLabel(text.mailLink, { exact: true })
  await expect(input).toBeEnabled()
  await pasteLink(input)
  await clickPrivate(button(scope, text.verify))
  await expect(scope.getByRole('status').filter({ hasText: text.verified })).toBeVisible()
  await expect(submit).toBeEnabled()
  return submit
}

async function expectRoles(page: Page, text: Labels) {
  const roster = page.getByRole('region', { name: text.roster, exact: true })
  const row = (name: string) =>
    roster.getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) })
  await expect(row(ownerName).getByText(text.admin, { exact: true })).toBeVisible()
  await expect(row(recipientName).getByText(text.owner, { exact: true })).toBeVisible()
}

async function auditPanel(page: Page, scope: Locator) {
  expect(await scope.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(
    await page.evaluate(() => {
      const root = document.documentElement
      return root.scrollWidth <= root.clientWidth
    }),
  ).toBe(true)
  const scan = await scanA11y(page)
  expect(scan.passes).toBeGreaterThan(0)
  expect(
    scan.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? '')),
  ).toEqual([])
}

test('owner and recipient explicitly verify and see ownership change in their existing sessions', async ({
  browser,
  page: owner,
  transfer,
}, testInfo) => {
  const language = testInfo.project.name === 'mobile' ? 'zh-CN' : 'en'
  const text = labels[language]
  const ownerViewport = { width: language === 'zh-CN' ? 320 : 1280, height: 900 }
  const ownerScheme = language === 'zh-CN' ? 'dark' : 'light'
  const recipientContext = await browser.newContext({
    viewport: { width: 320, height: 900 },
    colorScheme: ownerScheme === 'dark' ? 'light' : 'dark',
    timezoneId: 'UTC',
    serviceWorkers: 'block',
  })
  try {
    await transfer.signIn(owner.context(), 'owner', language)
    await transfer.signIn(recipientContext, 'recipient', language)
    const recipient = await recipientContext.newPage()
    await owner.setViewportSize(ownerViewport)
    await owner.emulateMedia({ colorScheme: ownerScheme })
    await owner.goto(transfer.url + transfer.path)
    const ownerPanel = panel(owner, text)
    const offer = button(owner, text.offer)
    await expect(offer).toBeEnabled()
    await offer.focus()
    await owner.keyboard.press('Enter')
    await expect(ownerPanel.getByRole('heading', { name: text.review })).toBeFocused()
    await expect(ownerPanel.getByText(text.ownRole, { exact: true })).toBeVisible()
    await expect(ownerPanel.getByRole('listitem').filter({ hasText: text.newRole })).toBeVisible()
    await expect(ownerPanel.getByText(text.boundary, { exact: true })).toBeVisible()
    await auditPanel(owner, ownerPanel)
    await button(ownerPanel, text.send).click()
    const send = await proveMailbox(ownerPanel, text, (field) =>
      transfer.pasteMailboxLink('owner', field),
    )
    const offerSent = transferResponse(owner, transfer.apiPath)
    await send.press('Enter')
    const offerResponse = await offerSent
    expect(offerResponse.status()).toBe(201)
    expect(offerResponse.request().headers()['x-expected-organization-id']).toBe(transfer.teamId)
    const { id, expiresAt } = (await offerResponse.json()) as { id: string; expiresAt: string }
    await expect(ownerPanel.getByRole('status')).toContainText(text.pending)
    await expect(ownerPanel.locator('time')).toHaveAttribute('datetime', expiresAt)
    expect(await transfer.roles()).toEqual(originalRoles)

    await recipient.goto(transfer.url + transfer.path)
    const recipientPanel = panel(recipient, text)
    await expect(recipientPanel.getByRole('status')).toContainText(text.pending)
    await expect(recipientPanel.locator('time')).toHaveAttribute('datetime', expiresAt)
    await expect(recipientPanel.getByText(text.originalRole, { exact: true })).toBeVisible()
    await expect(recipientPanel.getByText(text.newRole, { exact: true })).toBeVisible()
    await expect(recipientPanel.getByText(text.boundary, { exact: true })).toBeVisible()
    await expect(button(recipientPanel, text.decline)).toBeEnabled()
    await expect(button(recipientPanel, text.revoke)).toHaveCount(0)
    expect(await transfer.roles()).toEqual(originalRoles)
    await auditPanel(recipient, recipientPanel)

    await button(recipientPanel, text.accept).press('Enter')
    const confirm = await proveMailbox(recipientPanel, text, (field) =>
      transfer.pasteMailboxLink('recipient', field),
    )
    expect(await transfer.roles()).toEqual(originalRoles)
    const accepted = transferResponse(recipient, `${transfer.apiPath}/${id}/confirm`)
    await confirm.press('Enter')
    expect((await accepted).status()).toBe(200)
    await expect(recipientPanel.getByRole('status')).toContainText(text.completed)
    await expectRoles(recipient, text)
    await owner.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(ownerPanel.getByRole('status')).toContainText(text.completed)
    await expectRoles(owner, text)
    expect(await transfer.transferState(id)).toBe('confirmed')
    expect(await transfer.roles()).toEqual(transferredRoles)
  } finally {
    await recipientContext.close()
  }
})

test('the named recipient can decline and the owner sees the terminal offer', async ({
  browser,
  page: owner,
  transfer,
}) => {
  const text = labels.en
  const id = await transfer.seedOffer()
  const recipientContext = await browser.newContext({ serviceWorkers: 'block' })
  try {
    await transfer.signIn(owner.context(), 'owner', 'en')
    await transfer.signIn(recipientContext, 'recipient', 'en')
    const recipient = await recipientContext.newPage()
    await Promise.all([
      owner.goto(transfer.url + transfer.path),
      recipient.goto(transfer.url + transfer.path),
    ])
    const ownerPanel = panel(owner, text)
    const recipientPanel = panel(recipient, text)
    await expect(ownerPanel.getByRole('status')).toContainText(text.pending)
    await expect(recipientPanel.getByRole('status')).toContainText(text.pending)
    const withCredential = await recipient.request.get(transfer.url + transfer.apiPath, {
      headers: {
        'X-Expected-Organization-Id': transfer.teamId,
        Authorization: 'Bearer fixture-only',
      },
    })
    expect(withCredential.status()).toBe(403)
    const wrongContext = await recipient.request.get(transfer.url + transfer.apiPath, {
      headers: { 'X-Expected-Organization-Id': '10000000-0000-4000-8000-000000000000' },
    })
    expect(wrongContext.status()).toBe(409)
    expect(await transfer.transferState(id)).toBe('pending')
    const declined = transferResponse(recipient, `${transfer.apiPath}/${id}/decline`)
    await button(recipientPanel, text.decline).press('Enter')
    expect((await declined).status()).toBe(200)
    await expect(recipientPanel.getByRole('status')).toContainText(text.declined)
    await expect(button(recipientPanel, text.accept)).toHaveCount(0)
    await button(ownerPanel, text.refresh).click()
    await expect(ownerPanel.getByRole('status')).toContainText(text.revoked)
    expect(await transfer.transferState(id)).toBe('revoked')
    expect(await transfer.roles()).toEqual(originalRoles)
  } finally {
    await recipientContext.close()
  }
})

test('the owner revokes an offer and the recipient sees it close without a role change', async ({
  browser,
  page: owner,
  transfer,
}, testInfo) => {
  const language = testInfo.project.name === 'mobile' ? 'zh-CN' : 'en'
  const text = labels[language]
  const id = await transfer.seedOffer()
  const recipientContext = await browser.newContext({ serviceWorkers: 'block' })
  try {
    await transfer.signIn(owner.context(), 'owner', language)
    await transfer.signIn(recipientContext, 'recipient', language)
    const recipient = await recipientContext.newPage()
    await Promise.all([
      owner.goto(transfer.url + transfer.path),
      recipient.goto(transfer.url + transfer.path),
    ])
    const ownerPanel = panel(owner, text)
    const recipientPanel = panel(recipient, text)
    await expect(ownerPanel.getByRole('status')).toContainText(text.pending)
    await expect(recipientPanel.getByRole('status')).toContainText(text.pending)
    await expect(button(recipientPanel, text.accept)).toBeEnabled()
    await expect(button(recipientPanel, text.decline)).toBeEnabled()
    const received = transferResponse(owner, `${transfer.apiPath}/${id}/revoke`)
    await button(ownerPanel, text.revoke).press('Enter')
    expect((await received).status()).toBe(200)
    await expect(ownerPanel.getByRole('status')).toContainText(text.revoked)
    await expect(button(ownerPanel, text.revoke)).toHaveCount(0)
    await button(recipientPanel, text.refresh).click()
    await expect(recipientPanel.getByRole('status')).toContainText(text.revoked)
    await expect(button(recipientPanel, text.accept)).toHaveCount(0)
    await expect(button(recipientPanel, text.decline)).toHaveCount(0)
    expect(await transfer.transferState(id)).toBe('revoked')
    expect(await transfer.roles()).toEqual(originalRoles)
  } finally {
    await recipientContext.close()
  }
})

test('a proved confirmation racing the owner’s revocation has one outcome', async ({
  browser,
  page: owner,
  transfer,
}) => {
  const text = labels.en
  const id = await transfer.seedOffer()
  const recipientContext = await browser.newContext({ serviceWorkers: 'block' })
  try {
    await transfer.signIn(owner.context(), 'owner', 'en')
    await transfer.signIn(recipientContext, 'recipient', 'en')
    const recipient = await recipientContext.newPage()
    await Promise.all([
      owner.goto(transfer.url + transfer.path),
      recipient.goto(transfer.url + transfer.path),
    ])
    const ownerPanel = panel(owner, text)
    const recipientPanel = panel(recipient, text)
    await button(recipientPanel, text.accept).press('Enter')
    const confirm = await proveMailbox(recipientPanel, text, (field) =>
      transfer.pasteMailboxLink('recipient', field),
    )
    const confirmPath = `${transfer.apiPath}/${id}/confirm`
    const revokePath = `${transfer.apiPath}/${id}/revoke`
    // Release both browser writes together so neither can observe the result before submitting.
    const ready = Promise.withResolvers<void>()
    let requests = 0
    async function race(route: Route) {
      if (++requests === 2) ready.resolve()
      await ready.promise
      await route.continue()
    }
    await Promise.all([
      recipient.route(transfer.url + confirmPath, race),
      owner.route(transfer.url + revokePath, race),
    ])
    const acceptResponse = transferResponse(recipient, confirmPath)
    const revokeResponse = transferResponse(owner, revokePath)
    await Promise.all([confirm.press('Enter'), button(ownerPanel, text.revoke).press('Enter')])
    const accepted = (await acceptResponse).status()
    const revoked = (await revokeResponse).status()
    if (accepted === 200) {
      expect([403, 409]).toContain(revoked)
      expect(await transfer.transferState(id)).toBe('confirmed')
      expect(await transfer.roles()).toEqual(transferredRoles)
    } else {
      expect([accepted, revoked]).toEqual([409, 200])
      expect(await transfer.transferState(id)).toBe('revoked')
      expect(await transfer.roles()).toEqual(originalRoles)
    }
  } finally {
    await recipientContext.close()
  }
})

test('expiry removes the pending action without a write from either participant', async ({
  page,
  transfer,
}) => {
  const text = labels.en
  const id = await transfer.seedOffer()
  await transfer.signIn(page.context(), 'recipient', 'en')
  await page.goto(transfer.url + transfer.path)
  const scope = panel(page, text)
  await expect(scope.getByRole('status')).toContainText(text.pending)
  await expect(button(scope, text.accept)).toBeEnabled()
  await transfer.expireOffer(id)
  await button(scope, text.refresh).click()
  await expect(scope.getByRole('status')).toContainText(text.expired)
  await expect(button(scope, text.accept)).toHaveCount(0)
  await expect(button(scope, text.decline)).toHaveCount(0)
  expect(await transfer.transferState(id)).toBe('pending')
  expect(await transfer.roles()).toEqual(originalRoles)
})

test('member departure invalidates the offer before the owner refreshes', async ({
  browser,
  page: owner,
  transfer,
}) => {
  const text = labels.en
  const id = await transfer.seedOffer()
  const recipientContext = await browser.newContext({ serviceWorkers: 'block' })
  try {
    await transfer.signIn(owner.context(), 'owner', 'en')
    await transfer.signIn(recipientContext, 'recipient', 'en')
    await owner.goto(transfer.url + transfer.path)
    const scope = panel(owner, text)
    await expect(scope.getByRole('status')).toContainText(text.pending)
    const left = await recipientContext.request.post(
      `${transfer.url}/api/v1/teams/${transfer.teamId}/leave`,
      {
        headers: { Origin: transfer.url, 'X-Expected-Organization-Id': transfer.teamId },
        data: {},
      },
    )
    expect(left.status()).toBe(200)
    await button(scope, text.refresh).click()
    await expect(scope.getByRole('status')).toContainText(text.invalidated)
    await expect(button(scope, text.revoke)).toHaveCount(0)
    expect(await transfer.transferState(id)).toBe('invalidated')
    expect(await transfer.roles()).toEqual({ owner: 'owner', recipient: null })
  } finally {
    await recipientContext.close()
  }
})
