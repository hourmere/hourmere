import { admin as english } from '../../../apps/web/src/i18n/catalogues/en/admin.ts'
import { admin as chinese } from '../../../apps/web/src/i18n/catalogues/zh-CN/admin.ts'
import { PATHS, workflowRunHistoryPath } from '../../../apps/web/src/paths.ts'
import { AUDIT_NOW } from '../audit-data.ts'
import { type AuditLocale, prepareAuditLocale, settleAuditLayout } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'
import { measureLayout } from '../layout.ts'
import {
  AUDIT_HISTORY_WORKFLOW_ID,
  AUDIT_HISTORY_WORKFLOW_NAME,
  mockWorkflowRunHistoryAudit,
} from '../workflow-run-history-audit.ts'

test.use({ uiAudit: true })

test('browses workflow run history with a keyboard and on a narrow team-space screen', async ({
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
  const release = await mockWorkflowRunHistoryAudit(
    page,
    app,
    isMobile ? 'team-workflow-run-history' : 'workflow-run-history',
  )
  const expectNoHorizontalOverflow = async () => {
    const viewport = page.viewportSize()
    if (!viewport) throw new Error('Workflow history test requires a CSS viewport')
    await page.evaluate(settleAuditLayout)
    const findings = await page.evaluate(measureLayout, viewport)
    expect(
      findings.filter(({ code }) => ['document-overflow', 'element-overflow'].includes(code)),
    ).toEqual([])
  }
  try {
    await page.goto(app.url + PATHS.workflows)
    const main = page.getByRole('main')
    const entry = main.getByRole('link', {
      name: copy['Run history for {name}'].replace('{name}', AUDIT_HISTORY_WORKFLOW_NAME),
      exact: true,
    })
    if (isMobile) await entry.tap()
    else await entry.press('Enter')
    await expect(page).toHaveURL(app.url + workflowRunHistoryPath(AUDIT_HISTORY_WORKFLOW_ID))
    const heading = main.getByRole('heading', { name: copy['Run history'], exact: true, level: 1 })
    const skipped = main.getByText(copy['Mail budget limit reached'], { exact: true })
    const next = main.getByRole('button', { name: copy['Next page'], exact: true })
    const previous = main.getByRole('button', { name: copy['Previous page'], exact: true })
    await expect(heading).toBeVisible()
    await expect(skipped).toBeVisible()
    await expect(
      main.getByText(copy['Send outcome unknown'], { exact: true }).first(),
    ).toBeVisible()
    await expect(previous).toBeDisabled()
    await expectNoHorizontalOverflow()

    if (isMobile) await next.tap()
    else await next.press('Enter')
    await expect(previous).toBeEnabled()
    await expect(next).toBeDisabled()
    await expect(skipped).toHaveCount(0)
    if (!isMobile) await expect(heading).toBeFocused()
    await expectNoHorizontalOverflow()

    if (isMobile) await previous.tap()
    else {
      await page.keyboard.press('Tab')
      await expect(previous).toBeFocused()
      await page.keyboard.press('Enter')
    }
    await expect(skipped).toBeVisible()
    await expect(previous).toBeDisabled()
    if (!isMobile) await expect(heading).toBeFocused()
  } finally {
    await release()
  }
})
