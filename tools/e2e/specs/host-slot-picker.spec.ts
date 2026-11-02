import type { Page } from '@playwright/test'
import type { components } from '../../../apps/web/src/api/schema.d.ts'
import { expect, test } from '../fixtures.ts'

type Slot = components['schemas']['Slot']

test.use({ slotSnippets: true, permissions: ['clipboard-read', 'clipboard-write'] })

function nextWorkingDate() {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + 1)
  while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

/** Observe genuine public availability reads without replacing requests or responses. */
function exactRechecks(page: Page, selected: Slot[]) {
  return Promise.all(
    selected.map((slot) =>
      page.waitForResponse((response) => {
        const url = new URL(response.url())
        return (
          url.pathname === '/api/v1/public/fixture-host/call/slots' &&
          url.searchParams.get('start') === slot.start &&
          url.searchParams.get('end') === slot.end &&
          url.searchParams.get('durationMinutes') === '30' &&
          response.status() === 200
        )
      }),
    ),
  )
}

test('copies two saved open times as complete plain and rich email snippets', async ({
  page,
  app,
}) => {
  await app.auditSignIn(true)
  await app.configureDurations()
  const catalog = await page.request.get(`${app.url}/api/v1/event-types`)
  expect(catalog.ok()).toBe(true)
  const { data } = (await catalog.json()) as { data: components['schemas']['EventType'][] }
  const event = data.find((item) => item.slug === 'call')
  expect(Boolean(event)).toBe(true)
  if (!event) return

  await page.goto(`${app.url}/app/event-types/${event.id}`)
  await page.getByRole('button', { name: 'Pick open times', exact: true }).click()
  const picker = page.getByRole('region', { name: 'Copy open times into an email', exact: true })
  await expect(picker.getByRole('combobox', { name: 'Meeting length', exact: true })).toHaveValue(
    '30',
  )
  await expect(picker.getByRole('combobox', { name: 'Email language', exact: true })).toHaveValue(
    'en',
  )
  await expect(
    picker.getByRole('combobox', { name: 'Display time zone', exact: true }),
  ).toHaveValue('UTC')

  const date = nextWorkingDate()
  const listing = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return (
      url.pathname === '/api/v1/public/fixture-host/call/slots' &&
      url.searchParams.get('start') === `${date}T00:00:00.000Z` &&
      url.searchParams.get('durationMinutes') === '30' &&
      response.status() === 200
    )
  })
  await picker.getByLabel('Availability date (UTC)', { exact: true }).fill(date)
  const offered = ((await (await listing).json()) as { data: Slot[] }).data
  expect(offered.length).toBeGreaterThanOrEqual(2)
  const selected = offered.slice(0, 2)
  expect(
    selected.every((slot) => Date.parse(slot.end) - Date.parse(slot.start) === 30 * 60_000),
  ).toBe(true)

  const alternatives = picker.getByRole('group', { name: 'Available alternatives', exact: true })
  const choices = alternatives.getByRole('checkbox')
  await expect(choices.nth(1)).toBeEnabled()
  // Choose in reverse order by keyboard: output order is chronological, not click order.
  for (const index of [1, 0]) {
    const choice = choices.nth(index)
    await expect(choice).toHaveAccessibleName(/UTC.*\+00:00/)
    await choice.focus()
    await choice.press('Space')
    await expect(choice).toBeChecked()
  }
  await expect(
    picker.getByRole('status').filter({ hasText: '2 of 10 alternatives selected' }),
  ).toBeVisible()
  await picker.getByRole('button', { name: 'Preview email', exact: true }).click()
  const preview = picker.getByRole('textbox', {
    name: 'Complete plain-text email preview',
    exact: true,
  })
  const text = await preview.inputValue()
  expect(text).toContain('Fixture call')
  expect(text).toContain('30')
  const urls = text.match(/^https?:\/\/\S+$/gm) ?? []
  expect(urls).toHaveLength(2)
  expect(
    urls.map((link) => {
      const url = new URL(link)
      return {
        origin: url.origin,
        pathname: url.pathname,
        query: [...url.searchParams.entries()],
      }
    }),
  ).toEqual(
    selected.map((slot) => ({
      origin: app.url,
      pathname: app.personalPath,
      query: [
        ['start', slot.start],
        ['durationMinutes', '30'],
      ],
    })),
  )

  for (const kind of ['plain', 'rich'] as const) {
    const rechecked = exactRechecks(page, selected)
    await picker
      .getByRole('button', {
        name: kind === 'plain' ? 'Copy plain text' : 'Copy rich text',
        exact: true,
      })
      .click()
    const checks = await rechecked
    for (let index = 0; index < checks.length; index++) {
      const result = (await checks[index]?.json()) as { data: Slot[] }
      expect(result.data).toEqual([selected[index]])
    }
    await expect(
      picker.getByRole('status').filter({
        hasText:
          kind === 'plain' ? 'Plain text copied.' : 'Rich text copied with a plain-text fallback.',
      }),
    ).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text)

    if (kind === 'rich') {
      const copied = await page.evaluate(async () => {
        const [item] = await navigator.clipboard.read()
        if (!item) throw new Error('Expected a clipboard item')
        const plain = await (await item.getType('text/plain')).text()
        const html = await (await item.getType('text/html')).text()
        const fragment = new DOMParser().parseFromString(html, 'text/html')
        return {
          types: [...item.types].sort(),
          plain,
          links: [...fragment.querySelectorAll('a')].map((link) => ({
            href: link.href,
            label: link.textContent,
          })),
          unsafe: fragment.querySelector('script, iframe, form, img, style') !== null,
        }
      })
      expect(copied.types).toEqual(['text/html', 'text/plain'])
      expect(copied.plain).toBe(text)
      expect(copied.links.map((link) => link.href)).toEqual(urls)
      expect(copied.links.every((link) => /UTC.*\+00:00/.test(link.label ?? ''))).toBe(true)
      expect(copied.unsafe).toBe(false)
    }
  }
  expect(await app.rows()).toEqual([])
})
