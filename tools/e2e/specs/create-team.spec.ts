import type { Page } from '@playwright/test'
import { prepareAuditLocale, settleAuditLayout } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'
import { measureLayout } from '../layout.ts'

const viewport = { width: 320, height: 568 }
const longSlug = `Research-${'a'.repeat(54)}9`

async function fits(page: Page, state: string) {
  await page.evaluate(settleAuditLayout)
  const findings = await page.evaluate(measureLayout, viewport)
  expect(
    findings.filter((finding) =>
      ['document-overflow', 'element-overflow', 'scan-error'].includes(finding.code),
    ),
    `${state} fits the 320px viewport`,
  ).toEqual([])
}

for (const locale of ['en-US', 'zh-CN'] as const) {
  const chinese = locale === 'zh-CN'
  const text = {
    create: chinese ? '创建团队' : 'Create team',
    name: chinese ? '团队名称' : 'Team name',
    slug: chinese ? '团队公开地址' : 'Team public address',
    account: chinese ? '账号' : 'Account',
    owner: chinese ? '所有者' : 'Owner',
    bookings: chinese ? '预约' : 'Bookings',
    open: chinese ? '打开团队' : 'Open team',
  }

  test(`team creation supports keyboard, address failures and long names at 320px ${locale}`, async ({
    page,
    app,
  }) => {
    const name = chinese ? '研究团队'.repeat(50) : 'InternationalResearchTeam'.repeat(8)
    await app.auditSignIn(true, locale)
    await page.addInitScript(prepareAuditLocale, locale)
    await page.setViewportSize(viewport)
    await page.goto(`${app.url}/app/teams/new`)
    const teamName = page.getByLabel(text.name, { exact: true })
    const slug = page.getByLabel(text.slug, { exact: true })
    await teamName.focus()
    await page.keyboard.insertText(name)
    await page.keyboard.press('Tab')
    await expect(slug).toBeFocused()
    await page.keyboard.insertText('Admin')
    await page.keyboard.press('Enter')
    await expect(slug).toHaveAttribute('aria-invalid', 'true')
    await expect(slug).toBeFocused()
    await fits(page, 'Reserved team address')

    await slug.press('ControlOrMeta+A')
    await page.keyboard.insertText('FixtureTeam')
    const refused = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/auth/organization/create',
    )
    await slug.press('Enter')
    expect((await refused).status()).toBe(400)
    await expect(slug).toHaveAttribute('aria-invalid', 'true')
    await expect(slug).toBeFocused()
    await fits(page, 'Already used team address')

    let prompted = false
    page.once('dialog', async (dialog) => {
      prompted = dialog.type() === 'confirm' && /未保存|unsaved/.test(dialog.message())
      await dialog.dismiss()
    })
    await page.getByRole('link', { name: text.bookings, exact: true }).click()
    expect(prompted).toBe(true)
    expect(new URL(page.url()).pathname).toBe('/app/teams/new')
    await expect(teamName).toHaveValue(name)

    await slug.focus()
    await slug.press('ControlOrMeta+A')
    await page.keyboard.insertText(longSlug)
    const preview = page.locator('.preview').filter({ hasText: `/team/${longSlug}/` })
    await expect(preview).toBeVisible()
    await expect(preview.locator('a')).toHaveCount(0)
    await expect(page.locator(`a[href^="/${longSlug}/"]`)).toHaveCount(0)
    await fits(page, 'Long team address and name')
    const created = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/auth/organization/create',
    )
    await slug.press('Enter')
    const response = await created
    expect(response.status()).toBe(200)
    const organization = (await response.json()) as { name: string; slug: string }
    expect(organization.name).toBe(name)
    expect(organization.slug).toBe(longSlug)
    await expect.poll(() => new URL(page.url()).pathname).toBe('/app/settings')
    const account = page.getByRole('region', { name: text.account, exact: true })
    await expect(account).toContainText(name)
    await expect(account.getByText(text.owner, { exact: true })).toBeVisible()
    await fits(page, 'Created team name and role')
    await page.reload()
    await expect(account).toContainText(name)
    await expect(account.getByText(text.owner, { exact: true })).toBeVisible()
    await fits(page, 'Reloaded team name and role')
  })

  test(`a lost creation response recovers the real team without a duplicate POST ${locale}`, async ({
    page,
    app,
  }) => {
    await app.auditSignIn(true, locale)
    await page.addInitScript(prepareAuditLocale, locale)
    await page.setViewportSize(viewport)
    let creations = 0
    await page.route(`${app.url}/api/auth/organization/create`, async (route) => {
      creations++
      // Let the real transaction commit, then lose only its response to the browser.
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      await route.abort('failed')
    })
    await page.goto(`${app.url}/app/teams/new`)
    await page.getByLabel(text.name, { exact: true }).fill('Recovered research team')
    await page.getByLabel(text.slug, { exact: true }).fill('Recovered-Research')
    await page.getByRole('button', { name: text.create, exact: true }).press('Enter')
    const open = page.getByRole('button', { name: text.open, exact: true })
    await expect(open).toBeEnabled()
    expect(creations).toBe(1)
    await expect(page.getByRole('button', { name: text.create, exact: true })).toHaveCount(0)
    await expect(page.getByLabel(text.slug, { exact: true })).toBeDisabled()
    await fits(page, 'Recovered creation')
    await open.press('Enter')
    await expect.poll(() => new URL(page.url()).pathname).toBe('/app/settings')
    const account = page.getByRole('region', { name: text.account, exact: true })
    await expect(account).toContainText('Recovered research team')
    await expect(account.getByText(text.owner, { exact: true })).toBeVisible()
    expect(creations).toBe(1)
    const organizations = await page.request.get(`${app.url}/api/auth/organization/list`)
    expect(organizations.status()).toBe(200)
    const list = (await organizations.json()) as { slug: string }[]
    expect(list.filter((organization) => organization.slug === 'Recovered-Research')).toHaveLength(
      1,
    )
  })

  test(`a lost duplicate response keeps a personal address editable without treating it as a team ${locale}`, async ({
    page,
    app,
  }) => {
    await app.auditSignIn(true, locale)
    await page.addInitScript(prepareAuditLocale, locale)
    await page.setViewportSize(viewport)
    const originalResponse = await page.request.get(`${app.url}/api/v1/me`)
    expect(originalResponse.status()).toBe(200)
    const original = (await originalResponse.json()) as {
      organization: { id: string; slug: string; personal: boolean }
    }
    expect(original.organization.personal).toBe(true)
    let creations = 0
    let switches = 0
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/auth/organization/set-active') switches++
    })
    await page.route(`${app.url}/api/auth/organization/create`, async (route) => {
      creations++
      if (creations === 1) {
        const response = await route.fetch()
        expect(response.status()).toBe(400)
        await route.abort('failed')
      } else await route.continue()
    })
    await page.goto(`${app.url}/app/teams/new`)
    const teamName = page.getByLabel(text.name, { exact: true })
    const slug = page.getByLabel(text.slug, { exact: true })
    await teamName.fill('Research corrected address')
    await slug.fill(original.organization.slug)
    await slug.press('Enter')
    await expect(slug).toHaveAttribute('aria-invalid', 'true')
    await expect(slug).toBeFocused()
    await expect(slug).toBeEnabled()
    await expect(teamName).toHaveValue('Research corrected address')
    await expect(page.getByRole('button', { name: text.open, exact: true })).toHaveCount(0)
    expect(creations).toBe(1)
    expect(switches).toBe(0)
    const currentResponse = await page.request.get(`${app.url}/api/v1/me`)
    const current = (await currentResponse.json()) as {
      organization: { id: string; personal: boolean }
    }
    expect(current.organization.id).toBe(original.organization.id)
    expect(current.organization.personal).toBe(true)
    await fits(page, 'Personal address conflict')
    await slug.press('ControlOrMeta+A')
    await page.keyboard.insertText('Public-Research')
    await slug.press('Enter')
    await expect.poll(() => new URL(page.url()).pathname).toBe('/app/settings')
    const account = page.getByRole('region', { name: text.account, exact: true })
    await expect(account).toContainText('Research corrected address')
    await expect(account.getByText(text.owner, { exact: true })).toBeVisible()
    expect(creations).toBe(2)
    expect(switches).toBe(1)
  })
}
