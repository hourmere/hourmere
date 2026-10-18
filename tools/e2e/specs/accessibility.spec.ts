import { expect, test } from '../fixtures.ts'

test('the first native Tab reaches the skip link and Enter focuses the main content', async ({
  page,
  app,
}) => {
  await app.authorizeHost()
  await page.goto(`${app.url}/app/event-types`)
  await expect(page.getByRole('heading', { name: 'Event types', exact: true })).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('main')).toBeFocused()
})
