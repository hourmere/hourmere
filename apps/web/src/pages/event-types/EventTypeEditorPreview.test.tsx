import { readFileSync } from 'node:fs'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, expect, it, onTestFinished, vi } from 'vitest'
import { chooseLanguage } from '../../i18n/store.ts'
import { resolveEventTypeEditor } from '../../test/event-type-editor.ts'
import { fakeApi, json, ME, profile, renderApp, signedIn } from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType, schedule } from '../../test/fixtures.ts'

beforeAll(resolveEventTypeEditor)

const wideQuery = '(min-width: 1280px)'

function viewport(width: number) {
  let currentWidth = width
  const listeners = new Set<() => void>()
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === wideQuery && currentWidth >= 1280
    },
    addEventListener(type: string, listener: () => void) {
      if (query === wideQuery && type === 'change') listeners.add(listener)
    },
    removeEventListener(type: string, listener: () => void) {
      if (query === wideQuery && type === 'change') listeners.delete(listener)
    },
  }))
  return async (nextWidth: number) => {
    // The wide pane can render before the editor's effect subscribes to changes.
    await waitFor(() => expect(listeners.size).toBeGreaterThan(0))
    await act(async () => {
      currentWidth = nextWidth
      for (const listener of listeners) listener()
    })
  }
}

function setup() {
  chooseLanguage('en')
  const logoHash = 'a'.repeat(64)
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  return fakeApi({
    ...signedIn,
    ...profile(),
    'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    'GET /api/v1/branding': () => json(200, { brandLogo: logoHash, brandPrimaryColor: '#6644aa' }),
    [`GET /api/v1/branding/logo/${logoHash}`]: () =>
      new Response(png, { headers: { 'content-type': 'image/png' } }),
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () =>
      json(
        200,
        eventType({
          title: 'Saved call',
          location: { kind: 'zoom' },
          allowedDurationsMinutes: [15, 30],
          description: 'Saved description',
          questions: [{ id: 'topic', label: 'Saved question', type: 'short_text', required: true }],
        }),
      ),
  })
}

it('updates the booking page as the host edits without fetching or persisting the draft', async () => {
  viewport(1280)
  const api = setup()
  const user = userEvent.setup()
  const view = renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
  const title = await screen.findByRole('textbox', { name: 'Title' })
  const pane = within(await screen.findByRole('complementary', { name: 'Booking page preview' }))
  await waitFor(() => {
    const branded = view.container.querySelector<HTMLElement>('.public-branded')
    expect(branded?.style.getPropertyValue('--brand-light-accent')).toBeTruthy()
    expect(branded?.style.getPropertyValue('--brand-dark-accent')).toBeTruthy()
  })
  expect(pane.getByRole('img', { name: ME.organization.name }).getAttribute('src')).toBe(
    'data:image/png;base64,iVBORw0KGgo=',
  )
  const fetch = vi.mocked(globalThis.fetch)
  fetch.mockClear()
  const stored = vi.spyOn(Storage.prototype, 'setItem')
  const historyBefore = location.href

  fireEvent.change(title, { target: { value: 'Draft consultation' } })
  fireEvent.change(screen.getByRole('textbox', { name: /^Description/ }), {
    target: { value: 'A draft description for the invitee' },
  })
  await user.selectOptions(screen.getByLabelText('Where the meeting happens'), 'google_meet')
  await user.click(screen.getByRole('button', { name: '45 minutes' }))
  expect(pane.getByRole('heading', { name: 'Draft consultation' })).toBeTruthy()
  expect(pane.getByText('A draft description for the invitee')).toBeTruthy()
  expect(pane.getByText('Google Meet')).toBeTruthy()
  expect((pane.getByRole('radio', { name: '45 min' }) as HTMLInputElement).checked).toBe(true)
  expect(pane.getByRole('radio', { name: '15 min' })).toBeTruthy()

  const times = await pane.findByRole('list', { name: /^Times on / })
  const [firstTime] = within(times).getAllByRole('button')
  if (!firstTime) throw new Error('Expected a sample time')
  await user.click(firstTime)
  expect(pane.getByRole('textbox', { name: /^Saved question/ })).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: 'Question' }), {
    target: { value: 'Draft question' },
  })
  const question = pane.getByRole('textbox', { name: /^Draft question/ })
  expect(pane.queryByRole('textbox', { name: /^Saved question/ })).toBeNull()
  const bookingForm = question.closest('form')
  expect(bookingForm?.parentElement?.closest('form')).toBeNull()
  if (!bookingForm) throw new Error('Expected the public booking form')
  fireEvent.submit(bookingForm)
  expect(fetch).not.toHaveBeenCalled()
  expect(stored).not.toHaveBeenCalled()
  expect(location.href).toBe(historyBefore)
  expect(screen.getByTestId('location').textContent).toBe(`/app/event-types/${EVENT_TYPE_ID}`)
  const savedBrandRequests = api.calls.filter(({ path }) => path.startsWith('/api/v1/branding'))
  expect(savedBrandRequests).toHaveLength(2)
  expect(
    savedBrandRequests.map(({ headers }) => headers.get('X-Expected-Organization-Id')),
  ).toEqual([ME.organization.id, ME.organization.id])
})

it('places the preview beside the settings at 1280px and in a modal at 1279px', async () => {
  // jsdom exposes the element but leaves these two native modal APIs unimplemented.
  const dialogMethods = {
    showModal: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = true
      },
    },
    close: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = false
      },
    },
  }
  Object.defineProperties(HTMLDialogElement.prototype, dialogMethods)
  onTestFinished(() => {
    for (const method of Object.keys(dialogMethods))
      Reflect.deleteProperty(HTMLDialogElement.prototype, method)
  })
  const resize = viewport(1280)
  setup()
  const user = userEvent.setup()
  const view = renderApp('/app/event-types/new')
  const pane = await screen.findByRole('complementary', { name: 'Booking page preview' })
  expect(pane.previousElementSibling?.classList.contains('event-type-editor-settings')).toBe(true)
  expect(pane.closest('main')?.className).toBe('main-content-wide')
  expect(screen.queryByRole('button', { name: 'Preview booking page' })).toBeNull()

  await resize(1279)
  const trigger = await screen.findByRole('button', { name: 'Preview booking page' })
  expect(screen.queryByRole('complementary', { name: 'Booking page preview' })).toBeNull()
  expect(screen.queryByRole('dialog', { name: 'Booking page preview' })).toBeNull()
  expect(view.container.querySelector('.booking-layout')).toBeNull()
  expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
  trigger.focus()
  await user.keyboard('{Enter}')
  const dialog = await screen.findByRole('dialog', { name: 'Booking page preview' })
  expect(dialog.getAttribute('aria-modal')).toBe('true')
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' }))
  fireEvent(dialog, new Event('cancel', { cancelable: true }))
  expect(screen.queryByRole('dialog', { name: 'Booking page preview' })).toBeNull()
  expect(document.activeElement).toBe(trigger)
  await user.keyboard(' ')
  const reopenedDialog = await screen.findByRole('dialog', { name: 'Booking page preview' })
  await user.click(within(reopenedDialog).getByRole('button', { name: 'Close' }))
  expect(document.activeElement).toBe(trigger)
})

it('applies the two-column grid only at the wide breakpoint and makes the modal full screen', () => {
  const css = new CSSStyleSheet()
  css.replaceSync(
    readFileSync('apps/web/src/pages/event-types/event-type-editor-layout.css', 'utf8'),
  )
  const rules = [...css.cssRules]
  const layout = '.event-type-editor-layout'
  const wide = rules.find(
    (rule): rule is CSSMediaRule =>
      rule instanceof CSSMediaRule && rule.conditionText === wideQuery,
  )
  const grid = [...(wide?.cssRules ?? [])].find(
    (rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText === layout,
  )
  expect(grid?.style.display).toBe('grid')
  expect(grid?.style.gridTemplateColumns).toBe('minmax(0, 1fr) minmax(0, 1fr)')
  expect(rules.some((rule) => rule instanceof CSSStyleRule && rule.selectorText === layout)).toBe(
    false,
  )
  const dialog = rules.find(
    (rule): rule is CSSStyleRule =>
      rule instanceof CSSStyleRule && rule.selectorText === '.event-type-preview-dialog',
  )
  expect(dialog?.style.width).toBe('100%')
  expect(dialog?.style.height).toBe('100%')
})
