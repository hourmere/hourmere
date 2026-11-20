import { admin as english } from '../../../apps/web/src/i18n/catalogues/en/admin.ts'
import { admin as chinese } from '../../../apps/web/src/i18n/catalogues/zh-CN/admin.ts'
import { PATHS, workflowEditPath } from '../../../apps/web/src/paths.ts'
import { AUDIT_NOW, AUDIT_TITLE } from '../audit-data.ts'
import { type AuditLocale, prepareAuditLocale, settleAuditLayout } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'
import { measureLayout } from '../layout.ts'
import {
  AUDIT_EDITOR_WORKFLOW_ID,
  AUDIT_EDITOR_WORKFLOW_NAME,
  AUDIT_WORKFLOW_WEBHOOK_URL,
  mockWorkflowEditorAudit,
} from '../workflow-editor-audit.ts'

test.use({ uiAudit: true })

test('creates, previews and edits workflows with keyboard and narrow touch controls', async ({
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
  const release = await mockWorkflowEditorAudit(
    page,
    app,
    isMobile ? 'team-workflow-edit' : 'workflow-create',
  )
  try {
    await page.goto(app.url + PATHS.workflows)
    const main = page.getByRole('main')
    const heading = (name: string) => main.getByRole('heading', { name, exact: true })
    const button = (name: string) => main.getByRole('button', { name, exact: true })
    const link = (name: string) => main.getByRole('link', { name, exact: true })
    const field = (name: string) => main.getByLabel(name, { exact: true })
    const expectNoHorizontalOverflow = async () => {
      const viewport = page.viewportSize()
      if (!viewport) throw new Error('Workflow editor test requires a CSS viewport')
      await page.evaluate(settleAuditLayout)
      const findings = await page.evaluate(measureLayout, viewport)
      expect(
        findings.filter(({ code }) => ['document-overflow', 'element-overflow'].includes(code)),
      ).toEqual([])
    }
    const newLink = link(copy['New workflow'])
    if (isMobile) await newLink.tap()
    else await newLink.press('Enter')
    await expect(heading(copy['New workflow'])).toBeVisible()

    const name = field(copy['Workflow name'])
    const scope = field(copy['Applies to'])
    await name.fill('Synthetic workflow created from the editor')
    if (!isMobile) {
      await page.keyboard.press('Tab')
      await expect(scope).toBeFocused()
    }
    await scope.selectOption('event_type')
    await field(copy['Event type']).selectOption({ label: AUDIT_TITLE })
    const preview = button(copy['Preview workflow'])
    if (isMobile) await preview.tap()
    else await preview.press('Enter')
    await expect(heading(copy['Workflow preview'])).toBeFocused()
    await expect(
      main.getByText(copy['The example booking matches this workflow.'], { exact: true }),
    ).toBeVisible()
    await expectNoHorizontalOverflow()

    const create = button(copy['Create workflow'])
    if (isMobile) await create.tap()
    else await create.press('Enter')
    await expect(heading('Synthetic workflow created from the editor')).toBeVisible()

    const edit = link(copy['Edit {name}'].replace('{name}', AUDIT_EDITOR_WORKFLOW_NAME))
    if (isMobile) await edit.tap()
    else await edit.press('Enter')
    await expect(page).toHaveURL(app.url + workflowEditPath(AUDIT_EDITOR_WORKFLOW_ID))
    await expect(name).toHaveValue(AUDIT_EDITOR_WORKFLOW_NAME)
    if (isMobile) {
      const endpoint = field(copy['Webhook endpoint'])
      await expect(endpoint.locator('option:checked')).toHaveText(AUDIT_WORKFLOW_WEBHOOK_URL)
      await expectNoHorizontalOverflow()
    }
    await name.fill('Synthetic workflow updated from the editor')
    const save = button(copy['Save changes'])
    if (isMobile) await save.tap()
    else await save.press('Enter')
    await expect(heading('Synthetic workflow updated from the editor')).toBeVisible()
  } finally {
    await release()
  }
})
