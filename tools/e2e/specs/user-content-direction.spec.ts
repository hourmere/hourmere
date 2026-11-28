import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { LocationOption } from '../../../packages/scheduling/src/location-options.ts'
import { expect, pickSlot, test } from '../fixtures.ts'
import { selectPublicLanguage } from '../public-language.ts'

const title = '✨ 42 (أهلا بك) Team'
const hostName = 'נועה (Noa) [42]'
const inviteeName = 'ليلى (Layla) [7]'
const inviteeEmail = 'mixed.fixture@hourmere.invalid'
const roomUrl = 'https://room.invalid/a'
const roomEmail = 'noa@room.invalid'
const urlLine = `راجع (${roomUrl}).`
const emailLine = `דוא״ל (${roomEmail}).`
const firstLine = 'مرحبا بالعالم (Welcome) — Bring any questions to the session.'
const secondLine = 'שלום (Hello) — Here is the agenda for our discussion.'
const description = [
  firstLine,
  '',
  secondLine,
  'Review the examples (مثال) and bring your notes.',
  urlLine,
  emailLine,
  '技术讨论（示例）',
  '[123]?!',
].join('\n')
const question = {
  id: '00000000-0000-4000-8000-000000000091',
  label: 'ما الموضوع؟ (Topic)',
  options: ['שלום (Hello)', '技术讨论 (Technical)'] as const,
}
const notesQuestion = {
  id: '00000000-0000-4000-8000-000000000092',
  label: 'הערות (Notes)',
}
const locations = [
  { id: 'room', kind: 'link', url: roomUrl, label: 'غرفة (Room) [A]', isDefault: true },
  { id: 'office', kind: 'in_person', address: 'רחוב 42 (Office)', label: 'משרד (Office)' },
] as const satisfies readonly LocationOption[]
const mixedContent = { title, hostName, description, question, notesQuestion, locations }

async function expectBrowserAccessibleName(page: Page, role: string, name: string) {
  if (page.context().browser()?.browserType().name() !== 'chromium') return
  // Query Chromium's accessibility tree independently of Playwright role locators.
  const session = await page.context().newCDPSession(page)
  try {
    const { nodes } = await session.send('Accessibility.getFullAXTree')
    expect(nodes.some((node) => node.role?.value === role && node.name?.value === name)).toBe(true)
  } finally {
    await session.detach()
  }
}

async function expectRtlTitle(heading: Locator) {
  await expect(heading).toHaveAttribute('dir', 'auto')
  await expect(heading).toHaveCSS('direction', 'rtl')
  await expectVisualOrder(heading, 'أهلا', 'بك', 'rtl')
}

async function expectVisualOrder(
  locator: Locator,
  firstPart: string,
  lastPart: string,
  direction: 'ltr' | 'rtl',
) {
  const ordered = await locator.evaluate(
    (element, { firstPart, lastPart, direction }) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      const text = walker.nextNode()
      if (!text?.textContent) throw new Error('Missing mixed-direction text')
      const position = (part: string) => {
        const range = document.createRange()
        const start = text.textContent?.indexOf(part) ?? -1
        range.setStart(text, start)
        range.setEnd(text, start + part.length)
        return range.getBoundingClientRect()
      }
      const first = position(firstPart)
      const second = position(lastPart)
      return (
        first.y < second.y ||
        (first.y === second.y && (direction === 'ltr' ? first.x < second.x : first.x > second.x))
      )
    },
    { firstPart, lastPart, direction },
  )
  expect(ordered, `${firstPart} precedes ${lastPart} in visual ${direction} order`).toBe(true)
}

async function capturePublicBooking(page: Page, locale: 'en' | 'zh-CN', width: number) {
  const directory = process.env.HOURMERE_BIDI_SCREENSHOTS
  if (!directory) return
  // Only capture the public fixture before submission. Confirmation and management
  // pages can carry private booking links, even when all visible text is synthetic.
  await page.screenshot({
    path: join(directory, `mixed-rtl-booking-${locale}-${width}.png`),
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  })
}

async function expectDescriptionDisclosure(
  scope: Locator,
  expandedName: string,
  collapseName: string,
  captureExpanded?: () => Promise<void>,
) {
  const toggle = scope.getByRole('button', { name: expandedName, exact: true })
  const copy = scope.locator('.event-description-disclosure .event-description')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(await copy.textContent()).not.toContain('\n\n')
  await toggle.focus()
  await toggle.press('Enter')
  const collapse = scope.getByRole('button', { name: collapseName, exact: true })
  await expect(collapse).toBeFocused()
  await expect(collapse).toHaveAttribute('aria-expanded', 'true')
  expect(await collapse.getAttribute('aria-controls')).toBe(await copy.getAttribute('id'))
  await expectDescriptionText(copy)
  await captureExpanded?.()
  await collapse.press('Space')
  await expect(toggle).toBeFocused()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
}

async function expectDescriptionText(copy: Locator) {
  expect(await copy.textContent()).toBe(description)
  await expect(copy.locator('bdi').filter({ hasText: firstLine })).toHaveCSS('direction', 'rtl')
  await expect(copy.locator('bdi').filter({ hasText: secondLine })).toHaveCSS('direction', 'rtl')
  await expect(copy.locator('bdi').filter({ hasText: /^Review/ })).toHaveCSS('direction', 'ltr')
  await expect(copy.locator('bdi').filter({ hasText: /^技术/ })).toHaveCSS('direction', 'ltr')
  await expect(copy.locator('bdi').filter({ hasText: '[123]?!' })).toHaveCSS('direction', 'ltr')
  const url = copy.getByText(urlLine, { exact: true })
  const email = copy.getByText(emailLine, { exact: true })
  await expect(url).toHaveCSS('direction', 'rtl')
  await expect(email).toHaveCSS('direction', 'rtl')
  await expectVisualOrder(url, 'https', '/a', 'ltr')
  await expectVisualOrder(email, 'noa@', '.invalid', 'ltr')
}

test('mixed public content keeps visual order, accessible names, and submitted values', async ({
  page,
  app,
  isMobile,
}) => {
  await app.configureMixedDirection(mixedContent)
  const width = isMobile ? 320 : 1280
  await page.setViewportSize({ width, height: 900 })
  await page.goto(`${app.url}/fixture-host`)
  await expect(page.getByRole('heading', { name: hostName, exact: true })).toHaveCSS(
    'direction',
    'rtl',
  )
  const card = page.getByRole('link', { name: /أهلا بك.*Team.*30 min/ })
  await expectRtlTitle(card.locator('.event-card-title'))
  await expectBrowserAccessibleName(page, 'heading', hostName)
  await card.focus()
  await card.press('Enter')
  await expectRtlTitle(page.getByRole('heading', { name: title, exact: true }))
  await expect(page.locator('.event-facts').getByText(locations[0].label)).toHaveCSS(
    'direction',
    'rtl',
  )
  const layout = page.locator('.booking-layout')
  for (const { locale, expand, collapse } of [
    { locale: 'en', expand: 'Show more', collapse: 'Show less' },
    { locale: 'zh-CN', expand: '展开', collapse: '收起' },
  ] as const) {
    if (locale === 'zh-CN') await selectPublicLanguage(page, locale)
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')
    if (isMobile) {
      await expectDescriptionDisclosure(layout, expand, collapse, () =>
        capturePublicBooking(page, locale, width),
      )
    } else {
      await expectDescriptionText(
        layout.locator('.event-description-disclosure .event-description'),
      )
      await capturePublicBooking(page, locale, width)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
  }

  await pickSlot(page, page)
  const name = page.getByRole('textbox', { name: '你的姓名', exact: true })
  await name.fill(inviteeName)
  await expect(name).toHaveCSS('direction', 'rtl')
  await page.getByRole('textbox', { name: '邮箱', exact: true }).fill(inviteeEmail)
  const select = page.getByRole('combobox', { name: question.label, exact: true })
  const note = page.getByRole('textbox', { name: notesQuestion.label, exact: true })
  const notes = `${emailLine}\n${urlLine}`
  await note.fill(notes)
  await expect(note).toHaveCSS('direction', 'rtl')
  const confirm = page.getByRole('button', { name: '确认预约', exact: true })
  await confirm.press('Enter')
  const summary = page.locator('.error-summary')
  await expect(summary).toBeFocused()
  const errorName = `${question.label}：请选择一个选项。`
  const errorLink = summary.getByRole('link', { name: errorName, exact: true })
  await expect(errorLink.locator('bdi')).toHaveText(question.label)
  await expectBrowserAccessibleName(page, 'link', errorName)
  await errorLink.press('Enter')
  await expect(select).toBeFocused()

  const option = select.getByRole('option', { name: question.options[0], exact: true })
  await expect(option).toHaveAttribute('dir', 'auto')
  await expect(option).toHaveCSS('direction', 'rtl')
  await select.selectOption({ label: question.options[0] })

  const created = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/bookings'),
  )
  await confirm.click()
  const response = await created
  expect(response.ok()).toBe(true)
  const result = (await response.json()) as { booking: { id: string }; manageToken: string }
  expect(response.request().postDataJSON()).toMatchObject({
    invitee: { name: inviteeName, email: inviteeEmail },
    locationOptionId: locations[0].id,
    responses: { [question.id]: question.options[0], [notesQuestion.id]: notes },
  })
  await expect(page.getByRole('heading', { name: '预约成功', exact: true })).toBeFocused()
  await expectBrowserAccessibleName(page, 'heading', '预约成功')
  const confirmation = page.locator('.confirmation')
  const lede = confirmation.locator('.lede')
  expect(await lede.textContent()).toBe(`你与${hostName}的“${title}”预约已确认。`)
  await expect(lede.locator('bdi')).toHaveText([hostName, title])
  const invitee = confirmation
    .locator('dd')
    .filter({ hasText: `${inviteeName}（${inviteeEmail}）` })
  await expect(invitee.locator('bdi[dir="ltr"]')).toHaveText(inviteeEmail)
  const snapshot = await invitee.ariaSnapshot()
  expect(snapshot.includes(inviteeName)).toBe(true)
  expect(snapshot.indexOf(inviteeEmail)).toBeGreaterThan(snapshot.indexOf(inviteeName))
  const room = confirmation.getByRole('link', { name: roomUrl, exact: true })
  await expect(room).toHaveAttribute('href', roomUrl)
  await expect(room.locator('bdi')).toHaveCSS('direction', 'ltr')
  await expectBrowserAccessibleName(page, 'link', roomUrl)

  await page.goto(`${app.url}/booking`)
  await page.evaluate((token) => {
    window.location.hash = new URLSearchParams({ token }).toString()
  }, result.manageToken)
  await expect(page.getByRole('heading', { name: '你的预约', exact: true })).toBeVisible()
  await expect(page.locator('dd bdi').filter({ hasText: title })).toHaveCSS('direction', 'rtl')
  await expect(page.getByRole('link', { name: roomUrl, exact: true })).toHaveAttribute(
    'href',
    roomUrl,
  )
  await expect.poll(() => page.evaluate(() => window.location.hash === '')).toBe(true)

  await app.auditSignIn(true, 'zh-CN')
  await page.goto(`${app.url}/app/bookings`)
  const bookingName = `与${inviteeName}的${title}`
  const booking = page.getByRole('link', { name: bookingName, exact: true })
  await expect(booking.locator('bdi')).toHaveText([inviteeName, title])
  await expectBrowserAccessibleName(page, 'link', bookingName)

  await page.goto(`${app.url}/app/bookings/${result.booking.id}`)
  const mail = page.getByRole('link', { name: inviteeEmail, exact: true })
  await expect(mail).toHaveAttribute('href', `mailto:${inviteeEmail}`)
  await expect(mail.locator('bdi')).toHaveCSS('direction', 'ltr')
  const notesLabel = page.locator('dt bdi').filter({ hasText: notesQuestion.label })
  await expect(notesLabel).toHaveCSS('direction', 'rtl')
  const savedNotes = page.locator('dd').filter({ hasText: notes })
  await expect(savedNotes.locator('bdi')).toHaveText([emailLine, urlLine])
})

test('mixed content stays isolated in the dashboard, draft preview and embedded booking', async ({
  page,
  app,
}) => {
  const eventId = await app.configureMixedDirection(mixedContent)
  const { personalId: organizationId } = await app.authorizeTeamSession()
  const switched = await page.request.post(`${app.url}/api/auth/organization/set-active`, {
    headers: { Origin: app.url },
    data: { organizationId },
  })
  expect(switched.ok()).toBe(true)
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto(`${app.url}/app/event-types`)
  const actionName = `More actions for ${title}`
  const actions = page.getByRole('button', { name: actionName, exact: true })
  await expect(actions).toHaveAccessibleName(actionName)
  await expectBrowserAccessibleName(page, 'button', actionName)
  await actions.focus()
  await actions.press('Enter')
  const embedAction = page.getByRole('menuitem', { name: 'Embed', exact: true })
  await expect(embedAction).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(actions).toBeFocused()

  await page.goto(`${app.url}/app/event-types/${eventId}`)
  const previewButton = page.getByRole('button', { name: 'Preview booking page' })
  await previewButton.focus()
  await previewButton.press('Enter')
  const preview = page.getByRole('dialog', { name: 'Booking page preview' })
  await expectRtlTitle(preview.getByRole('heading', { name: title, exact: true }))
  await expect(preview.locator('.public-preview')).toHaveAttribute('dir', 'ltr')
  await expectDescriptionDisclosure(preview, 'Show more', 'Show less')
  await preview.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(previewButton).toBeFocused()

  await page.goto(app.parentUrl)
  const frame = page.frameLocator('iframe')
  await expectRtlTitle(frame.getByRole('heading', { name: title, exact: true }))
  await expectDescriptionDisclosure(frame.locator('.booking-layout'), 'Show more', 'Show less')
  await expect(frame.locator('html')).toHaveCSS('direction', 'ltr')
  expect(await frame.locator('html').evaluate((html) => html.scrollWidth <= html.clientWidth)).toBe(
    true,
  )
})
