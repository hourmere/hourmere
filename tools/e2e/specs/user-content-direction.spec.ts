import type { Locator, Page } from '@playwright/test'
import { expect, pickSlot, test } from '../fixtures.ts'
import { publicLanguageName } from '../public-language.ts'

const title = '✨ 42 (أهلا بك) Team'
const hostName = 'נועה (Noa) [42]'
const inviteeName = 'ليلى (Layla) [7]'
const inviteeEmail = 'mixed.fixture@hourmere.invalid'
const firstLine = 'مرحبا بالعالم (Welcome) — Bring any questions to the session.'
const secondLine = 'שלום (Hello) — Here is the agenda for our discussion.'
const description = [
  firstLine,
  '',
  secondLine,
  'Review the examples (مثال) and bring your notes.',
  '技术讨论（示例）',
  '[123]?!',
].join('\n')
const question = {
  id: '00000000-0000-4000-8000-000000000091',
  label: 'ما الموضوع؟ (Topic)',
  options: ['שלום (Hello)', '技术讨论 (Technical)'] as const,
}

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
  // The first Arabic word is on the right of the second in the rendered line.
  const ordered = await heading.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const text = walker.nextNode()
    if (!text?.textContent) throw new Error('Missing heading text')
    const position = (word: string) => {
      const range = document.createRange()
      const start = text.textContent?.indexOf(word) ?? -1
      range.setStart(text, start)
      range.setEnd(text, start + word.length)
      return range.getBoundingClientRect()
    }
    const first = position('أهلا')
    const second = position('بك')
    return first.y < second.y || (first.y === second.y && first.x > second.x)
  })
  expect(ordered).toBe(true)
}

async function expectDescriptionDisclosure(
  scope: Locator,
  expandedName: string,
  collapseName: string,
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
  expect(await copy.textContent()).toBe(description)
  await expect(copy.locator('bdi').filter({ hasText: firstLine })).toHaveCSS('direction', 'rtl')
  await expect(copy.locator('bdi').filter({ hasText: secondLine })).toHaveCSS('direction', 'rtl')
  await expect(copy.locator('bdi').filter({ hasText: /^Review/ })).toHaveCSS('direction', 'ltr')
  await expect(copy.locator('bdi').filter({ hasText: /^技术/ })).toHaveCSS('direction', 'ltr')
  await expect(copy.locator('bdi').filter({ hasText: '[123]?!' })).toHaveCSS('direction', 'ltr')
  await collapse.press('Space')
  await expect(toggle).toBeFocused()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
}

test('mixed public content keeps visual order, accessible names, and submitted values', async ({
  page,
  app,
}) => {
  await app.configureMixedDirection({ title, hostName, description, question })
  await page.setViewportSize({ width: 320, height: 900 })
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
  await expectDescriptionDisclosure(page.locator('.booking-layout'), 'Show more', 'Show less')

  await page.getByRole('button', { name: publicLanguageName }).click()
  await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')
  await expectDescriptionDisclosure(page.locator('.booking-layout'), '展开', '收起')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)

  await pickSlot(page, page)
  const name = page.getByRole('textbox', { name: '你的姓名', exact: true })
  await name.fill(inviteeName)
  await expect(name).toHaveCSS('direction', 'rtl')
  await page.getByRole('textbox', { name: '邮箱', exact: true }).fill(inviteeEmail)
  const select = page.getByRole('combobox', { name: question.label, exact: true })
  const option = select.getByRole('option', { name: question.options[0], exact: true })
  await expect(option).toHaveAttribute('dir', 'auto')
  await expect(option).toHaveCSS('direction', 'rtl')
  await select.selectOption({ label: question.options[0] })

  const created = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/bookings'),
  )
  await page.getByRole('button', { name: '确认预约', exact: true }).click()
  const submitted = (await created).request().postDataJSON()
  expect(submitted).toMatchObject({
    invitee: { name: inviteeName, email: inviteeEmail },
    responses: { [question.id]: question.options[0] },
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
})

test('mixed content stays isolated in the dashboard, draft preview and embedded booking', async ({
  page,
  app,
}) => {
  const eventId = await app.configureMixedDirection({ title, hostName, description, question })
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
