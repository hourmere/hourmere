import { admin as english } from '../../../apps/web/src/i18n/catalogues/en/admin.ts'
import { admin as chinese } from '../../../apps/web/src/i18n/catalogues/zh-CN/admin.ts'
import { PATHS } from '../../../apps/web/src/paths.ts'
import { AUDIT_NOW } from '../audit-data.ts'
import { type AuditLocale, prepareAuditLocale, settleAuditLayout } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'
import { AUDIT_WORKFLOW_NAME, mockWorkflowAudit } from '../workflow-audit.ts'

test.use({ uiAudit: true })

test('manages workflows with a keyboard and on a narrow team-space screen', async ({
  page,
  app,
  isMobile,
}) => {
  const copy = isMobile ? chinese : english
  const locale = isMobile ? 'zh-CN' : 'en-US'
  if (isMobile) await page.setViewportSize({ width: 320, height: 844 })
  await app.auditSignIn(true, locale, isMobile ? 'team' : undefined)
  await page.clock.setFixedTime(new Date(AUDIT_NOW))
  await page.addInitScript<AuditLocale>(prepareAuditLocale, locale)
  const release = await mockWorkflowAudit(page, app, isMobile ? 'team-workflows' : 'workflows')
  try {
    await page.goto(app.url + PATHS.workflows)
    const main = page.getByRole('main')
    await expect(main.getByRole('heading', { name: copy.Workflows, exact: true })).toBeVisible()
    const disable = main.getByRole('button', {
      name: copy['Disable {name}'].replace('{name}', AUDIT_WORKFLOW_NAME),
      exact: true,
    })
    const enable = main.getByRole('button', {
      name: copy['Enable {name}'].replace('{name}', AUDIT_WORKFLOW_NAME),
      exact: true,
    })
    const remove = main.getByRole('button', {
      name: copy['Delete {name}'].replace('{name}', AUDIT_WORKFLOW_NAME),
      exact: true,
    })
    if (isMobile) await disable.tap()
    else await disable.press('Enter')
    const prompt = main.getByRole('group', {
      name: copy['Disable this workflow? Runs picked up while it is disabled are skipped.'],
    })
    await expect(prompt.getByRole('button', { name: copy.Cancel, exact: true })).toBeFocused()
    await page.evaluate(settleAuditLayout)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(prompt).toHaveCount(0)
    await expect(disable).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(prompt.getByRole('button', { name: copy.Cancel, exact: true })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(
      prompt.getByRole('button', { name: copy['Disable workflow'], exact: true }),
    ).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(main.getByText(copy['Workflow disabled.'], { exact: true })).toBeVisible()
    await enable.press('Enter')
    await main.getByRole('button', { name: copy['Enable workflow'], exact: true }).press('Enter')
    await expect(main.getByText(copy['Workflow enabled.'], { exact: true })).toBeVisible()
    await remove.press('Enter')
    await main.getByRole('button', { name: copy['Delete workflow'], exact: true }).press('Enter')
    await expect(main.getByText(copy['Workflow deleted.'], { exact: true })).toBeVisible()
    await expect(main.getByRole('heading', { name: AUDIT_WORKFLOW_NAME, exact: true })).toHaveCount(
      0,
    )
  } finally {
    await release()
  }
})
