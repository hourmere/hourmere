import { type Response, request } from '@playwright/test'
import { expect, fillInvitee, pickSlot, test } from '../fixtures.ts'

function isTeamUpdate(response: Response) {
  return new URL(response.url()).pathname === '/api/auth/organization/update'
}

for (const locale of ['en-US', 'zh-CN'] as const) {
  const chinese = locale === 'zh-CN'
  const labels = chinese
    ? {
        details: '团队资料',
        name: '团队名称',
        address: '团队公开地址',
        save: '保存团队资料',
        saved: '团队资料已保存。',
        notice:
          '原有的预约链接、嵌入内容、路由链接以及已发送候补邮件中的预约链接将无法使用。保存后请更新已分享的链接和嵌入内容。旧地址将在 90 天内仅供此团队重新启用。',
        missing: '此预约页面不存在',
      }
    : {
        details: 'Team details',
        name: 'Team name',
        address: 'Team public address',
        save: 'Save team details',
        saved: 'Team details saved.',
        notice:
          'Old booking links, embeds, routing links and booking links in sent waitlist emails will stop working. Replace shared links and embeds after saving. For 90 days, only this team can reclaim the old address.',
        missing: 'This booking page doesn’t exist',
      }

  test.describe(locale, () => {
    test.use({ locale })

    test('team address notice matches what happens to a shared booking page', {
      tag: chinese ? [] : '@cross-engine',
    }, async ({ page, app }) => {
      const oldLink = app.url + app.teamPath
      const newLink = `${app.url}/team/research-team/call`
      const settings = `${app.url}/app/settings`
      const event = page.getByRole('heading', { name: 'Team fixture call', exact: true })
      const details = page.getByRole('region', { name: labels.details, exact: true })
      const name = details.getByRole('textbox', { name: labels.name, exact: true })
      const address = details.getByRole('textbox', { name: labels.address, exact: true })
      const save = details.getByRole('button', { name: labels.save, exact: true })
      const notice = details.getByText(labels.notice, { exact: true })
      const saved = details.getByRole('status').filter({ hasText: labels.saved })
      const inline = page.frameLocator('[data-hourmere-inline] iframe')
      async function openEmbed(url: string) {
        app.setEmbedSnippet(
          `<div data-hourmere-inline data-hourmere-url="${url}" data-hourmere-language="${chinese ? 'zh-CN' : 'en'}"></div><script src="${app.url}/hourmere-embed.js" defer></script>`,
        )
        await page.goto(`${app.parentUrl}/generated-embed`)
      }

      await openEmbed(oldLink)
      await expect(inline.getByRole('heading', { name: 'Team fixture call' })).toBeVisible()
      await page.goto(oldLink)
      await expect(event).toBeVisible()

      let existing: { id: string; start: string; manageLink: string } | undefined
      if (!chinese) {
        await pickSlot(page, page)
        await fillInvitee(page)
        const created = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' && response.url().endsWith('/bookings'),
        )
        await page.getByRole('button', { name: 'Confirm booking', exact: true }).click()
        const response = await created
        expect(response.status()).toBe(201)
        const { booking } = (await response.json()) as { booking: { id: string; start: string } }
        await expect(
          page.getByRole('heading', { name: 'You’re booked', exact: true }),
        ).toBeVisible()
        const manageLink = await page
          .getByLabel('Your link to change or cancel this booking')
          .inputValue()
        existing = { ...booking, manageLink }
      }

      await app.auditSignIn(true, locale, 'team')
      await page.goto(settings)
      await name.fill('Renamed research team')
      await expect(notice).toHaveCount(0)
      await save.click()
      await expect(saved).toBeVisible()
      await page.goto(oldLink)
      await expect(event).toBeVisible()

      await page.goto(settings)
      await expect(name).toHaveValue('Renamed research team')
      await expect(address).toHaveValue('FixtureTeam')
      await address.fill('Research-Team')
      await expect(notice).toBeVisible()
      await expect(address).toHaveAccessibleDescription(/90/)
      await save.click()
      await expect(saved).toBeVisible()
      await expect(address).toHaveValue('research-team')
      await expect(notice).toHaveCount(0)

      if (existing) {
        const detailPath = `/api/v1/team/bookings/${existing.id}`
        await page.goto(`${app.url}/app/team/bookings?tab=all`)
        const row = page.getByRole('row').filter({ hasText: 'Fixture Invitee' })
        await expect(row.locator('time')).toHaveAttribute('datetime', existing.start)
        await expect(row.getByText('Confirmed', { exact: true })).toBeVisible()
        const loaded = page.waitForResponse(
          (response) => new URL(response.url()).pathname === detailPath,
        )
        await row.getByRole('button', { name: 'Team fixture call', exact: true }).click()
        expect((await loaded).status()).toBe(200)
        const history = page.getByRole('region', { name: 'Team booking details' })
        await expect(
          history.getByRole('link', { name: 'fixture-invitee@hourmere.invalid', exact: true }),
        ).toBeVisible()
        await expect(history.getByText('Confirmed', { exact: true })).toBeVisible()
      }

      await app.auditSignIn(false)
      await page.goto(oldLink)
      await expect(page.getByRole('heading', { name: labels.missing, exact: true })).toBeVisible()
      await expect(page).toHaveURL(oldLink)
      await page.goto(newLink)
      await expect(event).toBeVisible()
      await openEmbed(oldLink)
      await expect(inline.getByRole('heading', { name: labels.missing, exact: true })).toBeVisible()
      await openEmbed(newLink)
      await expect(inline.getByRole('heading', { name: 'Team fixture call' })).toBeVisible()

      if (existing) {
        await page.goto(`${app.url}/booking`)
        await expect(page.getByRole('heading', { name: 'Open your booking link' })).toBeVisible()
        await page.evaluate((link) => {
          window.location.hash = new URL(link).hash
        }, existing.manageLink)
        await expect(page.locator('.booking-details').getByText('Team fixture call')).toBeVisible()
        await expect(page.getByRole('button', { name: 'Reschedule', exact: true })).toBeVisible()
      }
    })
  })
}

test('members and other teams have no editor for the target team', async ({ page, app }) => {
  const account = page.getByRole('region', { name: 'Account', exact: true })
  const details = page.getByRole('region', { name: 'Team details', exact: true })

  await app.authorizeTeamSession('member')
  await page.goto(`${app.url}/app/settings`)
  await expect(account).toContainText('FixtureTeam')
  await expect(account.getByText('Member', { exact: true })).toBeVisible()
  await expect(details).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save team details', exact: true })).toHaveCount(0)

  await app.authorizeTeamSession('other-team')
  await page.goto(`${app.url}/app/settings`)
  await expect(details.getByRole('textbox', { name: 'Team public address' })).toHaveValue(
    'other-fixture-team',
  )
  await page.getByRole('button', { name: /^Switch space other-fixture-team/ }).click()
  const menu = page.getByRole('menu', { name: 'Spaces', exact: true })
  await expect(menu.getByRole('menuitemradio', { name: /^other-fixture-team/ })).toBeVisible()
  await expect(menu.getByRole('menuitemradio', { name: /^FixtureTeam/ })).toHaveCount(0)
})

for (const state of ['revoked', 'expired'] as const) {
  test(`a ${state} browser session cannot submit an open team settings form`, async ({
    page,
    context,
    app,
  }) => {
    const session = await app.authorizeTeamSession()
    const settings = `${app.url}/app/settings`
    await page.goto(settings)
    const details = page.getByRole('region', { name: 'Team details', exact: true })
    const name = details.getByRole('textbox', { name: 'Team name', exact: true })
    const address = details.getByRole('textbox', { name: 'Team public address', exact: true })
    const save = details.getByRole('button', { name: 'Save team details', exact: true })
    await name.fill('Stale session team name')
    await address.fill('stale-session-team')
    await expect(save).toBeEnabled()

    // Keep the original cookie and draft in the open page while invalidating its session.
    if (state === 'revoked') {
      const signOutClient = await request.newContext({ storageState: await context.storageState() })
      try {
        const signedOut = await signOutClient.post(`${app.url}/api/auth/sign-out`, {
          headers: { Origin: app.url },
          data: {},
        })
        expect(signedOut.status()).toBe(200)
      } finally {
        await signOutClient.dispose()
      }
    } else {
      await session.expire()
    }

    const refused = page.waitForResponse(isTeamUpdate)
    await save.click()
    expect((await refused).status()).toBe(401)
    await expect(page.getByRole('heading', { name: 'Sign in to Hourmere' })).toBeVisible()
    await expect(details).toHaveCount(0)

    await app.authorizeTeamSession()
    await page.goto(settings)
    await expect(name).toHaveValue('FixtureTeam')
    await expect(address).toHaveValue('FixtureTeam')
  })
}
