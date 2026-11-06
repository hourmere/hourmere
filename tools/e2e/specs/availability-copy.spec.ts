import AxeBuilder from '@axe-core/playwright'
import { openAuditPage } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'

test.use({ uiAudit: true })

test('copies midnight hours and saves the week and date overrides together', async ({
  page,
  app,
}) => {
  await openAuditPage(page, app, 'availability-editor')
  await page.getByLabel('Monday, hours 1, from', { exact: true }).fill('18:00')
  await page.getByLabel('Monday, hours 1, until', { exact: true }).fill('00:00')
  const copy = page.getByRole('button', { name: 'Copy to… Copy hours from Monday', exact: true })
  await copy.focus()
  await copy.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Copy hours from Monday' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Weekdays', exact: true }).click()
  await expect(dialog.getByRole('checkbox', { name: 'Tuesday', exact: true })).toBeChecked()
  await dialog.getByRole('button', { name: 'Apply copy', exact: true }).click()
  await expect(copy).toBeFocused()
  await expect(page.getByLabel('Tuesday, hours 1, from', { exact: true })).toHaveValue('18:00')
  await expect(page.getByLabel('Tuesday, hours 1, until', { exact: true })).toHaveValue('00:00')
  await page.getByRole('button', { name: 'Add a date override', exact: true }).click()
  await page
    .getByRole('group', { name: /^Date override / })
    .last()
    .getByLabel('Date', { exact: true })
    .fill('2030-12-24')
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PUT' && response.url().endsWith('/availability'),
  )
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  expect((await saved).status()).toBe(200)
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('Tuesday, hours 1, until', { exact: true })).toHaveValue('00:00')
  await expect(page.locator('input[type="date"]').filter({ visible: true })).toHaveValue(
    '2030-12-24',
  )
  // Clean pages leave without prompting; dirty back navigation retains the draft on dismiss.
  await page.getByRole('link', { name: 'Back to availability', exact: true }).click()
  await page.getByRole('link', { name: 'Edit Synthetic working hours', exact: true }).click()
  await page.getByLabel('Name', { exact: true }).fill('Unsaved hours')
  const prompt = page.waitForEvent('dialog')
  await page.evaluate(() => window.history.back())
  await (await prompt).dismiss()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved hours')
  await page.getByLabel('Name', { exact: true }).fill('Synthetic working hours')
  await page.evaluate(() => window.history.back())
  await expect(page.getByRole('region', { name: 'Your schedules' })).toBeVisible()
})

test('two tabs preserve the winner and retain the conflicting draft', async ({ page, app }) => {
  await openAuditPage(page, app, 'availability-editor')
  const second = await page.context().newPage()
  try {
    await second.goto(page.url())
    await expect(second.getByLabel('Name', { exact: true })).toHaveValue('Synthetic working hours')
    await page.getByLabel('Name', { exact: true }).fill('Saved by first tab')
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible()
    await second.getByLabel('Name', { exact: true }).fill('Second tab draft')
    await second.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(second.getByRole('alert')).toContainText('This schedule changed in another tab.')
    await expect(second.getByLabel('Name', { exact: true })).toHaveValue('Second tab draft')
    await page.reload()
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Saved by first tab')
  } finally {
    await second.close()
  }
})

for (const language of ['en', 'zh-CN'] as const) {
  test(`copy controls retain their visible labels in accessible names (${language})`, async ({
    page,
    app,
  }) => {
    await openAuditPage(page, app, 'availability-editor')
    await page
      .getByRole('combobox', { name: 'Interface language', exact: true })
      .selectOption(language)
    const visible = language === 'en' ? 'Copy to…' : '复制到…'
    const controls = page.locator('.weekday-copy')
    await expect(controls).toHaveCount(7)
    for (const control of await controls.all()) {
      await expect(control).toHaveText(visible)
      await expect(control).toHaveAccessibleName(new RegExp(visible))
    }
    const result = await new AxeBuilder({ page })
      .include('.week')
      .withRules(['label-content-name-mismatch'])
      .analyze()
    expect(result.violations.map(({ id, impact }) => ({ id, impact }))).toEqual([])
  })
}
