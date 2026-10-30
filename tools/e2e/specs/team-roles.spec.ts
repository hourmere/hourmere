import type { Page } from '@playwright/test'
import { scanA11y } from '../a11y.ts'
import { settleAuditLayout } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'
import { measureLayout } from '../layout.ts'

async function auditRoles(page: Page) {
  await page.evaluate(settleAuditLayout)
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('The role review requires a viewport')
  expect(await page.evaluate(measureLayout, viewport)).toEqual([])
  const scan = await scanA11y(page)
  expect(scan.passes).toBeGreaterThan(0)
  expect(
    scan.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? '')),
  ).toEqual([])
}

for (const locale of ['en', 'zh-CN'] as const) {
  test(`team roles preserve owner protections and keyboard focus in ${locale}`, async ({
    page,
    app,
  }, testInfo) => {
    test.setTimeout(90_000)
    await app.auditSignIn(true, locale, 'team')
    await page.setViewportSize({
      width: testInfo.project.name === 'mobile' ? 320 : 1280,
      height: 1000,
    })
    await page.goto(`${app.url}/app/settings`)
    const members = page.getByRole('region', { name: /^(Team members|团队成员)$/ })
    const row = members.getByRole('listitem').filter({ hasText: 'Second Required Host' })
    const ownerRow = members.getByRole('listitem').filter({ hasText: 'Fixture Host' })
    await expect(row).toBeVisible()
    await expect(ownerRow.getByRole('button')).toHaveCount(0)
    await expect(
      members.getByText(/Only owners can manage admins|只有所有者可以管理管理员/),
    ).toBeVisible()
    const promote = row.getByRole('button', { name: /^(Make admin|设为管理员)[:：]/ })
    await promote.focus()
    await page.keyboard.press('Enter')
    const review = row.getByRole('region', { name: /^(Change team role|更改团队角色)$/ })
    await expect(review.getByRole('heading')).toBeFocused()
    await expect(review).toContainText('Second Required Host')
    await auditRoles(page)
    await page.keyboard.press('Escape')
    await expect(review).toHaveCount(0)
    await expect(promote).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(review.getByRole('heading')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(review.getByRole('button', { name: /^(Cancel|取消)$/ })).toBeFocused()
    await page.keyboard.press('Tab')
    const confirm = review.getByRole('button', { name: /^(Confirm role change|确认更改角色)$/ })
    await expect(confirm).toBeFocused()
    const promoted = page.waitForResponse((response) =>
      response.url().endsWith('/organization/update-member-role'),
    )
    await page.keyboard.press('Enter')
    const promotion = await promoted
    expect(promotion.status()).toBe(200)
    const member = (await promotion.json()) as { id: string; organizationId: string }
    expect(promotion.request().headers()['x-expected-organization-id']).toBe(member.organizationId)
    await expect(row.getByText(/^(Admin|管理员)$/)).toBeVisible()
    const demote = row.getByRole('button', { name: /^(Make member|设为成员)[:：]/ })
    await expect(demote).toBeFocused()
    await expect(row.getByRole('status')).toContainText(/Admin|管理员/)
    await auditRoles(page)

    await demote.press('Enter')
    await auditRoles(page)
    const demoted = page.waitForResponse((response) =>
      response.url().endsWith('/organization/update-member-role'),
    )
    await confirm.press('Enter')
    expect((await demoted).status()).toBe(200)
    await expect(row.getByText(/^(Member|成员)$/)).toBeVisible()
    await expect(promote).toBeFocused()
    await auditRoles(page)

    const list = await page.request.get(
      `${app.url}/api/auth/organization/list-members?organizationId=${member.organizationId}`,
    )
    expect(list.status()).toBe(200)
    const data = (await list.json()) as { members: { id: string; role: string }[] }
    const owner = data.members.find((item) => item.role === 'owner')
    if (!owner) throw new Error('The fixture must retain its owner')
    const denied = await page.request.post(`${app.url}/api/auth/organization/update-member-role`, {
      headers: { Origin: app.url, 'X-Expected-Organization-Id': member.organizationId },
      data: { organizationId: member.organizationId, memberId: owner.id, role: 'member' },
    })
    expect(denied.status()).toBe(403)
    expect((await denied.json()).code).toBe('TEAM_MANAGEMENT_ACCESS_DENIED')
    await page.reload()
    await expect(ownerRow.getByText(/^(Owner|所有者)$/)).toBeVisible()
    await expect(ownerRow.getByRole('button')).toHaveCount(0)
  })
}
