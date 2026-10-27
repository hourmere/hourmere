import { expect, test } from '../fixtures.ts'

test('a stale team draft refuses a cross-tab session switch and reloads only after discard consent', async ({
  page,
  context,
  app,
}) => {
  const { teamId, personalId } = await app.authorizeTeamSession()
  const before = await app.eventTypeTitles()
  const otherTab = await context.newPage()
  // Keep the switching tab on the owned origin without mounting another app/session poller.
  await otherTab.goto(`${app.url}/api/health`)
  await page.goto(`${app.url}/app/event-types/new`)
  await page.getByLabel('Title', { exact: true }).fill('Unsaved team draft')

  const switched = await otherTab.evaluate(async (organizationId) => {
    const response = await fetch('/api/auth/organization/set-active', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId }),
    })
    return response.status
  }, personalId)
  expect(switched).toBe(200)

  const refused = page.waitForResponse(
    (response) =>
      response.url() === `${app.url}/api/v1/event-types` && response.request().method() === 'POST',
  )
  // Submit without refocusing the old tab: focus/visibility refresh is best effort, and
  // the server must also refuse a stale form that reaches it before that refresh.
  await page.getByLabel('Title', { exact: true }).evaluate((input) => {
    const form = (input as HTMLInputElement).form
    form?.requestSubmit()
  })
  const response = await refused
  expect(response.status()).toBe(409)
  expect(response.request().headers()['x-expected-organization-id']).toBe(teamId)
  expect(await response.json()).toMatchObject({ error: 'organization_context_changed' })
  await expect(page.getByRole('alert')).toContainText(
    'Your team context changed. Reload before making changes.',
  )
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Unsaved team draft')
  expect(await app.eventTypeTitles()).toEqual(before)

  page.once('dialog', (dialog) => dialog.dismiss())
  await page.getByRole('button', { name: 'Reload', exact: true }).click()
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Unsaved team draft')

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Reload', exact: true }).click()
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('Scheduling', { exact: true })).toHaveCount(0)
  expect(await app.eventTypeTitles()).toEqual(before)
  await otherTab.close()
})
