import type { Locator } from '@playwright/test'
import { scanA11y } from '../a11y.ts'
import { expect, test } from '../custom-roles-fixtures.ts'

async function prove(panel: Locator, nextLink: () => Promise<string>) {
  await expect(panel.getByRole('heading')).toBeFocused()
  await panel.getByRole('button', { name: /^(Send verification email|发送验证邮件)$/u }).click()
  const input = panel.getByLabel(/^(Email verification link|邮箱验证链接)$/u)
  await expect(input).toBeFocused()
  await input.fill(await nextLink())
  await panel.getByRole('button', { name: /^(Verify email link|验证邮箱链接)$/u }).click()
  await panel.getByRole('button', { name: /^(Continue|继续)$/u }).click()
}

for (const locale of ['en', 'zh-CN'] as const) {
  test(`custom team roles opt-in, assignment and browser renewal in ${locale}`, async ({
    page,
    roles,
  }) => {
    const settings = `${roles.url}/app/settings`
    const root = `${roles.url}/api/v1/teams/${roles.teamId}`
    const ownerProof = page.getByRole('region', {
      name: /^(Confirm your identity before changing team roles\.|更改团队角色前，请先验证身份。)$/u,
    })
    const management = page.getByRole('region', { name: /^(Roles and permissions|角色与权限)$/u })
    const wordings = {
      enable: /^(Turn on custom roles|启用自定义角色)$/u,
      confirmEnable: /^(Confirm turning on custom roles|确认启用自定义角色)$/u,
      create: /^(Create custom role|创建自定义角色)$/u,
      name: /^(Custom role name|自定义角色名称)$/u,
      publish: /^(Create and publish role|创建并发布角色)$/u,
      brandingPreset: /^(Access preset for Branding|品牌设置的权限预设)$/u,
      assignment:
        /^(Change custom role for Fixture Member|更改自定义角色（\s*Fixture Member\s*）)$/u,
      select: /^(Custom role for this member|此成员的自定义角色)$/u,
      save: /^(Save custom role assignment|保存自定义角色分配)$/u,
      brandingRead: /^(View team branding|查看团队品牌设置)$/u,
      renewal: /^(Renew team access|重新验证团队权限)$/u,
      renew: /^(Verify and renew team access|验证并更新团队权限)$/u,
      memberProof:
        /^(Confirm your identity to renew team access\.|请验证身份以重新获取团队权限。)$/u,
      accepted: /^(Team actions available in this browser|此浏览器可执行的团队操作)$/u,
    }

    await roles.signIn('member', locale)
    await page.goto(settings)
    await expect(page.getByRole('region', { name: /^(Team members|团队成员)$/u })).toBeVisible()
    await expect(management).toHaveCount(0)
    await expect(page.getByRole('region', { name: wordings.renewal })).toHaveCount(0)
    expect((await page.request.get(`${roles.url}/api/v1/branding`)).status()).toBe(403)

    await roles.signIn('owner', locale)
    await page.goto(settings)
    await management.getByRole('button', { name: wordings.enable }).click()
    await management.getByRole('button', { name: wordings.confirmEnable }).click()
    await prove(ownerProof, () => roles.proofLink(0))

    const create = management.getByRole('button', { name: wordings.create })
    await create.press('Enter')
    await expect(management.getByRole('heading', { name: wordings.create })).toBeFocused()
    await management.getByLabel(wordings.name).fill('Branding Reader')
    await management.getByLabel(wordings.brandingPreset).selectOption('read')
    await expect(management.getByText(wordings.brandingRead)).toBeVisible()
    const scan = await scanA11y(page)
    expect(scan.passes).toBeGreaterThan(0)
    expect(
      scan.violations.filter(({ impact }) => ['serious', 'critical'].includes(impact ?? '')),
    ).toEqual([])
    await management.getByRole('button', { name: wordings.publish }).click()
    await prove(ownerProof, () => roles.proofLink(1))

    await expect(management.getByText('Branding Reader')).toBeVisible()
    const assignment = page.getByRole('button', { name: wordings.assignment })
    await assignment.press('Enter')
    const review = page.getByRole('region', { name: wordings.assignment })
    await expect(review.getByRole('heading')).toBeFocused()
    await review.getByLabel(wordings.select).selectOption({ label: 'Branding Reader' })
    await expect(review.getByText(wordings.brandingRead)).toBeVisible()
    await review.getByRole('button', { name: wordings.save }).click()
    await prove(ownerProof, () => roles.proofLink(2))
    await expect(assignment).toBeFocused()

    await roles.signIn('admin', locale)
    await page.goto(settings)
    await expect(page.getByRole('region', { name: /^(Team members|团队成员)$/u })).toBeVisible()
    await expect(management).toHaveCount(0)
    await expect(assignment).toHaveCount(0)
    expect((await page.request.get(`${root}/members/${roles.memberId}/custom-role`)).status()).toBe(
      403,
    )

    await roles.signIn('member', locale)
    await page.goto(settings)
    const renewal = page.getByRole('region', { name: wordings.renewal })
    await expect(renewal.getByText(wordings.brandingRead)).toBeVisible()
    expect((await page.request.get(`${roles.url}/api/v1/branding`)).status()).toBe(403)
    await renewal.getByRole('button', { name: wordings.renew }).click()
    await prove(page.getByRole('region', { name: wordings.memberProof }), () => roles.proofLink(3))
    await expect(
      page.getByRole('region', { name: wordings.accepted }).getByText(wordings.brandingRead),
    ).toBeVisible()
    expect((await page.request.get(`${roles.url}/api/v1/branding`)).status()).toBe(200)
    const branding = page.getByRole('region', {
      name: /^(Booking page branding|预约页面品牌设置)$/u,
    })
    await branding.getByRole('button', { name: wordings.brandingRead }).click()
    await expect(
      branding.getByRole('region', { name: /^(Booking page preview|预约页预览)$/u }),
    ).toBeVisible()
    await expect(
      branding.getByRole('form', { name: /^(Edit branding|编辑品牌设置)$/u }),
    ).toHaveCount(0)
    expect((await page.request.get(`${roles.url}/api/v1/team/bookings`)).status()).toBe(403)
    await expect(management).toHaveCount(0)
  })
}
