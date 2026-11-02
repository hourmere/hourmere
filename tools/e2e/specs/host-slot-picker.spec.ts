import type { Page } from '@playwright/test'
import type { components } from '../../../apps/web/src/api/schema.d.ts'
import { expect, test } from '../fixtures.ts'

type Slot = components['schemas']['Slot']

test.use({
  slotSnippets: true,
  // WebKit and Firefox require a real user gesture and do not expose these permissions.
  permissions: async ({ browserName }, use) => {
    await use(browserName === 'chromium' ? ['clipboard-read', 'clipboard-write'] : [])
  },
})

type ClipboardAttempt = {
  duringTrustedClick: boolean
  promised: boolean[]
  initialStates: string[]
  states: string[]
  status: 'pending' | 'fulfilled' | 'rejected'
  types: string[]
  plain?: string
  links?: { href: string; label: string | null }[]
  unsafe?: boolean
}

/** Observe native clipboard calls and promise inputs without replacing browser behavior. */
async function observeClipboard(page: Page) {
  await page.evaluate(() => {
    const attempts: ClipboardAttempt[] = []
    const inputs = new WeakMap<ClipboardItem, { promised: boolean[]; states: string[] }>()
    const NativeItem = window.ClipboardItem
    let click: MouseEvent | undefined
    document.addEventListener(
      'click',
      (event) => {
        if (
          event.target instanceof Element &&
          /^Copy (plain|rich) text$/.test(event.target.closest('button')?.textContent ?? '')
        )
          click = event
      },
      true,
    )
    window.ClipboardItem = new Proxy(NativeItem, {
      construct(target, arguments_) {
        const values = arguments_[0] as Record<string, Blob | Promise<Blob>>
        const item = Reflect.construct(target, arguments_) as ClipboardItem
        const state = {
          promised: Object.values(values).map((value) => value instanceof Promise),
          states: Object.values(values).map(() => 'pending'),
        }
        inputs.set(item, state)
        for (const [index, value] of Object.values(values).entries())
          void Promise.resolve(value).then(
            () => {
              state.states[index] = 'fulfilled'
            },
            () => {
              state.states[index] = 'rejected'
            },
          )
        return item
      },
    })
    const nativeWrite = navigator.clipboard.write.bind(navigator.clipboard)
    navigator.clipboard.write = (items) => {
      const item = items[0]
      if (!item) throw new Error('Expected one complete clipboard item')
      const input = inputs.get(item)
      const attempt: ClipboardAttempt = {
        duringTrustedClick: Boolean(click?.isTrusted && click.eventPhase !== Event.NONE),
        promised: [...(input?.promised ?? [])],
        initialStates: [...(input?.states ?? [])],
        states: input?.states ?? [],
        status: 'pending',
        types: [...item.types].sort(),
      }
      attempts.push(attempt)
      // Call the real browser API in this exact stack, preserving activation requirements.
      return nativeWrite(items).then(
        async () => {
          attempt.plain = await (await item.getType('text/plain')).text()
          if (item.types.includes('text/html')) {
            const html = await (await item.getType('text/html')).text()
            const fragment = new DOMParser().parseFromString(html, 'text/html')
            attempt.links = [...fragment.querySelectorAll('a')].map((link) => ({
              href: link.href,
              label: link.textContent,
            }))
            attempt.unsafe = fragment.querySelector('script, iframe, form, img, style') !== null
          }
          attempt.status = 'fulfilled'
        },
        (error: unknown) => {
          attempt.status = 'rejected'
          throw error
        },
      )
    }
    Object.assign(window, { slotPickerClipboardAttempts: attempts })
  })
}

function clipboardAttempts(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { slotPickerClipboardAttempts: ClipboardAttempt[] })
        .slotPickerClipboardAttempts,
  )
}

/** Paste through the browser instead of bypassing WebKit/Firefox's clipboard-read gesture. */
async function pastedClipboard(page: Page) {
  const id = 'slot-picker-clipboard-inspection'
  await page.evaluate((testId) => {
    const textarea = document.createElement('textarea')
    textarea.dataset.testid = testId
    textarea.setAttribute('aria-label', 'Synthetic clipboard inspection')
    document.body.append(textarea)
  }, id)
  const inspection = page.getByTestId(id)
  try {
    await inspection.focus()
    await inspection.press('ControlOrMeta+V')
    return await inspection.inputValue()
  } finally {
    await inspection.evaluate((element) => element.remove())
  }
}

/** Hold a genuine permission reread; no HTTP response or availability result is mocked. */
async function holdPermissionRead(page: Page) {
  let release = () => {}
  let reached = () => {}
  let completed = () => {}
  const waiting = new Promise<void>((resolve) => {
    reached = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const finished = new Promise<void>((resolve) => {
    completed = resolve
  })
  const pattern = `${new URL(page.url()).origin}/api/v1/me`
  const handler = async (route: import('@playwright/test').Route) => {
    reached()
    await held
    try {
      await route.continue()
    } finally {
      completed()
    }
  }
  await page.route(pattern, handler)
  return {
    waiting,
    release: async () => {
      const response = page.waitForResponse(pattern)
      release()
      await finished
      await response
      await page.unroute(pattern, handler)
    },
  }
}

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
  browserName,
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

  const alternatives = picker.getByRole('group', { name: 'Available times', exact: true })
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
    picker.getByRole('status').filter({ hasText: 'Selected times: 2 (maximum 10)' }),
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

  await observeClipboard(page)
  for (const [index, kind] of (['plain', 'rich'] as const).entries()) {
    const rechecked = exactRechecks(page, selected)
    const held = await holdPermissionRead(page)
    const button = picker.getByRole('button', {
      name: kind === 'plain' ? 'Copy plain text' : 'Copy rich text',
      exact: true,
    })
    try {
      await button.click()
      await held.waiting
      const attempts = await clipboardAttempts(page)
      expect(attempts).toHaveLength(index + 1)
      expect(attempts[index]).toMatchObject({
        duringTrustedClick: true,
        promised: kind === 'plain' ? [true] : [true, true],
        initialStates: kind === 'plain' ? ['pending'] : ['pending', 'pending'],
        states: kind === 'plain' ? ['pending'] : ['pending', 'pending'],
        status: 'pending',
      })
      // The input remains pending until every permission and exact interval read completes.
      await expect(button).toBeFocused()
    } finally {
      await held.release()
    }
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
    await expect(button).toBeFocused()
    const copied = (await clipboardAttempts(page))[index]
    expect(copied?.status).toBe('fulfilled')
    expect(copied?.plain).toBe(text)
    // Cross-engine projects run serially; the parallel Chromium functional suite
    // inspects native write completion/data without racing the system clipboard.
    if (browserName !== 'chromium') expect(await pastedClipboard(page)).toBe(text)
    if (kind === 'rich' && copied) {
      expect(copied.types).toEqual(['text/html', 'text/plain'])
      expect(copied.links?.map((link) => link.href)).toEqual(urls)
      expect(copied.links?.every((link) => /UTC.*\+00:00/.test(link.label ?? ''))).toBe(true)
      expect(copied.unsafe).toBe(false)
    }
  }
  expect(await app.rows()).toEqual([])

  // Make one alternative genuinely stale after preview: one rejection must cancel both MIME types.
  const booked = await page.request.post(`${app.url}/api/v1/public${app.personalPath}/bookings`, {
    data: {
      start: selected[0]?.start,
      durationMinutes: 30,
      invitee: {
        name: 'Synthetic competing invitee',
        email: 'synthetic-competing@hourmere.invalid',
        timeZone: 'UTC',
      },
    },
  })
  expect(booked.status()).toBe(201)
  const held = await holdPermissionRead(page)
  try {
    await picker.getByRole('button', { name: 'Copy rich text', exact: true }).click()
    await held.waiting
    expect((await clipboardAttempts(page))[2]).toMatchObject({
      duringTrustedClick: true,
      promised: [true, true],
      states: ['pending', 'pending'],
      status: 'pending',
    })
  } finally {
    await held.release()
  }
  await expect.poll(async () => (await clipboardAttempts(page))[2]?.status).toBe('rejected')
  expect((await clipboardAttempts(page))[2]?.states).toEqual(['rejected', 'rejected'])
  expect(
    (await clipboardAttempts(page)).filter((attempt) => attempt.status === 'fulfilled'),
  ).toHaveLength(2)
  if (browserName !== 'chromium') expect(await pastedClipboard(page)).toBe(text)
  await expect(picker.getByRole('status').filter({ hasText: /no longer offered/i })).toBeVisible()
  expect(await app.rows()).toEqual([{ source: 'web', status: 'confirmed' }])
})
