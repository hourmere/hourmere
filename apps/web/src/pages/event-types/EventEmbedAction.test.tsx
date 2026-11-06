import '../../i18n/admin.ts'
import * as embedSnippets from '@hourmere/core/embed-snippet'
import { embedSnippet } from '@hourmere/core/embed-snippet'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chooseLanguage } from '../../i18n/store.ts'
import {
  fakeApi,
  json,
  later,
  ME,
  profile,
  type Routes,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType, schedule } from '../../test/fixtures.ts'
import { EventEmbedAction } from './EventEmbedAction.tsx'

const PUBLIC_URL = 'https://schedule.example.test'
const ORIGINS = ['https://www.example.com', 'https://blog.example.com']
const UNKNOWN =
  'Embedding configuration is unavailable. Ask the instance operator to confirm allowed website origins.'
const INVALID_PUBLIC_URL =
  'The instance public URL is unavailable for embedding. Ask the instance operator to check PUBLIC_URL.'
const INVALID_BOOKING_PATH =
  'This saved booking address cannot be embedded. Use a saved personal or team booking link.'
const GENERATION_FAILED = 'Could not generate embed code. Check the embed settings and try again.'
const DISABLED =
  'Embedding is disabled. The instance operator must set EMBED_ALLOWED_ORIGINS and restart the web process. For example:'
const TEAM = { ...ME, organization: { ...ME.organization, personal: false, slug: 'Design-TEAM' } }

// jsdom does not implement native modal behavior. Assert showModal usage and exercise
// the browser's cancel event; focus containment itself is supplied by HTMLDialogElement.
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
      this.querySelector<HTMLButtonElement>('button')?.focus()
    }),
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    }),
  })
})

function instance(
  origins: string[] | undefined = ORIGINS,
  publicUrl: string | undefined = PUBLIC_URL,
) {
  return {
    publicUrl,
    embedAllowedOrigins: origins,
    hostedSignupUrl: 'https://hourmere.com',
    signIn: { email: true, google: false, microsoft: false },
  }
}

async function openAction(
  event = eventType(),
  bookingPath: string | null = '/ada/intro-call',
  routes: Routes = {},
) {
  fakeApi({ 'GET /api/v1/instance/embed': () => json(200, instance()), ...routes })
  render(<EventEmbedAction event={event} bookingPath={bookingPath} />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Embed' }))
  return user
}

function code() {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Embed code' })
}
function dialog() {
  return screen.getByRole('dialog')
}

function page(event = eventType(), me = ME, routes: Routes = {}) {
  return fakeApi({
    ...signedInAs(me),
    ...profile(),
    'GET /api/v1/instance/embed': () => json(200, instance()),
    'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    'GET /api/v1/event-types': () => json(200, { data: [event] }),
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, event),
    'GET /api/v1/event-type-hosts': () =>
      json(200, { data: [{ id: me.user.id, name: me.user.name }], nextAfter: null }),
    ...routes,
  })
}

describe('saved event embed dialog', () => {
  it.each(['/ada/intro-call', '/team/Design-TEAM/intro-call'])(
    'copies both documented modes using PUBLIC_URL for %s, including hidden events',
    async (bookingPath) => {
      const user = await openAction(eventType({ isHidden: true }), bookingPath)
      await screen.findByRole('textbox', { name: 'Embed code' })
      expect(code().value).toBe(
        embedSnippet({ publicUrl: PUBLIC_URL, bookingPath, mode: 'inline' }),
      )
      expect(dialog().textContent).toContain(
        'This event type is unlisted. The embed still works; anyone with the code or direct link can book it.',
      )
      for (const origin of ORIGINS) expect(screen.getByText(origin)).toBeDefined()
      await user.click(screen.getByRole('button', { name: 'Copy embed code' }))
      expect(await navigator.clipboard.readText()).toBe(code().value)
      await user.selectOptions(screen.getByLabelText('Embed mode'), 'popup')
      expect(code().value).toBe(embedSnippet({ publicUrl: PUBLIC_URL, bookingPath, mode: 'popup' }))
      await user.click(screen.getByRole('button', { name: 'Copy embed code' }))
      expect(await navigator.clipboard.readText()).toBe(code().value)
      expect(dialog().querySelector('iframe,script')).toBeNull()
    },
  )

  it('escapes custom button text, validates height, and keeps popup independent of invalid inline height', async () => {
    const user = await openAction(eventType({ title: '<img src=x onerror=alert(1)>' }))
    await screen.findByRole('textbox', { name: 'Embed code' })
    expect(screen.getByRole('dialog', { name: 'Embed <img src=x onerror=alert(1)>' })).toBeDefined()
    await user.clear(screen.getByLabelText('Initial height (pixels)'))
    await user.type(screen.getByLabelText('Initial height (pixels)'), '239')
    expect(screen.queryByLabelText('Embed code')).toBeNull()
    expect(screen.getByLabelText('Initial height (pixels)').getAttribute('aria-invalid')).toBe(
      'true',
    )
    await user.clear(screen.getByLabelText('Initial height (pixels)'))
    await user.type(screen.getByLabelText('Initial height (pixels)'), '800')
    expect(code().value).toContain('data-hourmere-height="800"')
    await user.clear(screen.getByLabelText('Initial height (pixels)'))
    await user.selectOptions(screen.getByLabelText('Embed mode'), 'popup')
    await user.clear(screen.getByLabelText('Button text'))
    expect(screen.queryByRole('button', { name: 'Copy embed code' })).toBeNull()
    expect(screen.getByText('Enter button text so visitors can identify the button.')).toBeDefined()
    expect(screen.getByLabelText('Button text').getAttribute('aria-invalid')).toBe('true')
    await user.type(screen.getByLabelText('Button text'), '<img src=x> & "hello"')
    expect(code().value).toContain('&lt;img src=x&gt; &amp; &quot;hello&quot;')
    expect(dialog().querySelector('img')).toBeNull()
  })

  it('shows the exact operator example for known empty origins and still offers code', async () => {
    await openAction(eventType(), '/ada/intro-call', {
      'GET /api/v1/instance/embed': () => json(200, instance([])),
    })
    await screen.findByText(DISABLED)
    expect(dialog().querySelector('pre')?.textContent).toBe(
      'PUBLIC_URL=https://hourmere.example.com\nEMBED_ALLOWED_ORIGINS=https://www.example.com,https://blog.example.com',
    )
    expect(code().value).toContain(PUBLIC_URL)
    expect(screen.queryByText(UNKNOWN)).toBeNull()
  })

  it.each([401, 403, 503])(
    'keeps HTTP %i neutral and retries instance discovery',
    async (status) => {
      let attempt = 0
      const user = await openAction(eventType(), '/ada/intro-call', {
        'GET /api/v1/instance/embed': () =>
          ++attempt === 1 ? json(status, { error: 'unavailable' }) : json(200, instance()),
      })
      await screen.findByRole('button', { name: 'Try again' })
      expect(screen.getByText(UNKNOWN)).toBeDefined()
      expect(screen.queryByText(DISABLED)).toBeNull()
      expect(screen.queryByLabelText('Embed code')).toBeNull()
      await user.click(screen.getByRole('button', { name: 'Try again' }))
      await screen.findByLabelText('Embed code')
    },
  )

  it('shows only a neutral loading status until configuration discovery finishes', async () => {
    const pending = later()
    await openAction(eventType(), '/ada/intro-call', {
      'GET /api/v1/instance/embed': () => pending.response,
    })
    expect(screen.getByText('Loading instance settings…')).toBeDefined()
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.queryByText(UNKNOWN)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.queryByText(DISABLED)).toBeNull()
    expect(screen.queryByLabelText('Embed code')).toBeNull()
    await pending.answer(json(200, { publicUrl: PUBLIC_URL }))
    expect(screen.getByText(UNKNOWN)).toBeDefined()
    expect(screen.queryByText('Loading instance settings…')).toBeNull()
    expect(screen.queryByText(DISABLED)).toBeNull()
    expect(code().value).toContain(PUBLIC_URL)
  })

  it.each([undefined, 'https://schedule.example.test/app', 'javascript:alert(1)'])(
    'never substitutes the admin origin for invalid PUBLIC_URL %s',
    async (publicUrl) => {
      await openAction(eventType(), '/ada/intro-call', {
        'GET /api/v1/instance/embed': () => json(200, { ...instance(), publicUrl }),
      })
      await screen.findByText(INVALID_PUBLIC_URL)
      expect(screen.queryByText(INVALID_BOOKING_PATH)).toBeNull()
      expect(screen.queryByText(GENERATION_FAILED)).toBeNull()
      expect(screen.queryByLabelText('Embed code')).toBeNull()
    },
  )

  it('asks to finish setup when no saved booking path is available', async () => {
    await openAction(eventType(), null)
    await screen.findByText('Complete the saved event setup before generating embed code.')
    expect(screen.queryByLabelText('Embed code')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy embed code' })).toBeNull()
    expect(screen.queryByText(INVALID_PUBLIC_URL)).toBeNull()
  })

  it.each(['/book/one-time-test-value', '/app/event-types', '/ada/<script>'])(
    'explains the rejected booking path %s without blaming PUBLIC_URL',
    async (bookingPath) => {
      await openAction(eventType(), bookingPath)
      await screen.findByText(INVALID_BOOKING_PATH)
      expect(screen.queryByText(INVALID_PUBLIC_URL)).toBeNull()
      expect(screen.queryByText(GENERATION_FAILED)).toBeNull()
      expect(screen.queryByLabelText('Embed code')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Copy embed code' })).toBeNull()
    },
  )

  it('describes an unexpected generation failure without blaming an accepted address', async () => {
    vi.spyOn(embedSnippets, 'embedSnippet').mockImplementation(() => {
      throw new Error('Unexpected generation failure')
    })
    await openAction()
    await screen.findByText(GENERATION_FAILED)
    expect(screen.queryByText(INVALID_PUBLIC_URL)).toBeNull()
    expect(screen.queryByText(INVALID_BOOKING_PATH)).toBeNull()
    expect(screen.queryByLabelText('Embed code')).toBeNull()
  })

  it('explains inactivity and offers no code', async () => {
    await openAction(eventType({ isActive: false }))
    await screen.findByText(
      'This event type is inactive. Enable it and save before generating embed code.',
    )
    expect(screen.queryByLabelText('Embed code')).toBeNull()
  })

  it('keeps selectable manual-copy code when clipboard access fails', async () => {
    const user = await openAction()
    await screen.findByLabelText('Embed code')
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    const before = code().value
    await user.click(screen.getByRole('button', { name: 'Copy embed code' }))
    await screen.findByText('Could not copy; select the text and copy it yourself')
    code().focus()
    code().select()
    expect(code().readOnly).toBe(true)
    expect(code().selectionStart).toBe(0)
    expect(code().selectionEnd).toBe(before.length)
    expect(code().value).toBe(before)
  })

  it('opens a native labelled modal, handles cancellation and returns focus', async () => {
    const user = await openAction()
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled()
    expect(dialog().getAttribute('aria-describedby')).toBeTruthy()
    expect(document.activeElement).toBe(within(dialog()).getByRole('button', { name: 'Close' }))
    fireEvent(dialog(), new Event('cancel', { bubbles: false, cancelable: true }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Embed' }))
    await user.keyboard('{Enter}')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Embed' }))
  })

  it('translates the complete dialog into Simplified Chinese', async () => {
    chooseLanguage('zh-CN')
    fakeApi({ 'GET /api/v1/instance/embed': () => json(200, instance([])) })
    render(<EventEmbedAction event={eventType()} bookingPath="/ada/intro-call" />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '嵌入' }))
    await screen.findByRole('textbox', { name: '嵌入代码' })
    expect(screen.getByRole('dialog', { name: '嵌入 Intro call' })).toBeDefined()
    expect(
      screen.getByText(
        '嵌入功能已停用。实例运维人员需要设置 EMBED_ALLOWED_ORIGINS 并重启网页服务。例如：',
      ),
    ).toBeDefined()
    await user.selectOptions(screen.getByLabelText('嵌入方式'), 'popup')
    expect(screen.getByLabelText<HTMLInputElement>('按钮文字').value).toBe('预约会议')
  })
})

describe('event page entry points', () => {
  it('closes the menu on Tab and Shift+Tab and continues through neighboring controls', async () => {
    render(
      <>
        <button type="button">Before</button>
        <EventEmbedAction event={eventType()} bookingPath="/ada/intro-call" inMenu />
        <button type="button">After</button>
      </>,
    )
    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: 'More actions for Intro call' })
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    await user.tab()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After' }))
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    await user.tab({ shift: true })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Before' }))
  })
  it('uses the saved editor address after an unsaved slug change', async () => {
    page()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const user = userEvent.setup()
    await screen.findByRole('heading', { name: 'Edit “Intro call”', level: 1 })
    await user.clear(screen.getByLabelText('Booking link'))
    await user.type(screen.getByLabelText('Booking link'), 'unsaved-draft')
    await user.click(screen.getByRole('button', { name: 'Embed' }))
    await screen.findByLabelText('Embed code')
    expect(code().value).toContain(`${PUBLIC_URL}/ada/intro-call`)
    expect(code().value).not.toContain('unsaved-draft')
  })

  it.each(['owner', 'member'])(
    'keeps team sharing and the weekly-hours hint, with an accessible row menu for %s',
    async (role) => {
      page(eventType({ ownerUserId: null, isHidden: true }), TEAM, {
        'GET /api/v1/schedules': () => json(200, { data: [] }),
        'GET /api/auth/organization/get-active-member': () =>
          json(200, { organizationId: TEAM.organization.id, userId: TEAM.user.id, role }),
      })
      renderApp('/app/event-types')
      const user = userEvent.setup()
      const trigger = await screen.findByRole('button', { name: 'More actions for Intro call' })
      expect(screen.getByRole('link', { name: 'Set your weekly hours' })).toBeDefined()
      expect(screen.getByRole('link', { name: 'Edit Intro call' })).toBeDefined()
      expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
      trigger.focus()
      await user.keyboard('{ArrowDown}')
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      const menu = screen.getByRole('menu', { name: 'More actions for Intro call' })
      expect(menu.id).toBe(trigger.getAttribute('aria-controls'))
      const item = within(menu).getByRole('menuitem', { name: 'Embed' })
      expect(document.activeElement).toBe(item)
      await user.keyboard('{End}{Home}{ArrowUp}{ArrowDown}')
      expect(document.activeElement).toBe(item)
      await user.keyboard('{Escape}')
      expect(document.activeElement).toBe(trigger)
      expect(screen.queryByRole('menu')).toBeNull()
      await user.keyboard('{ArrowUp}{Enter}')
      await screen.findByLabelText('Embed code')
      expect(code().value).toContain(`${PUBLIC_URL}/team/Design-TEAM/intro-call`)
      await user.click(screen.getByRole('button', { name: 'Close' }))
      expect(document.activeElement).toBe(trigger)
      await user.click(trigger)
      await user.click(screen.getByRole('heading', { name: 'Event types', level: 1 }))
      expect(screen.queryByRole('menu')).toBeNull()
    },
  )

  it('has no embed action on an unsaved event', async () => {
    page()
    renderApp('/app/event-types/new')
    await screen.findByRole('heading', { name: 'New event type', level: 1 })
    expect(screen.queryByRole('button', { name: 'Embed' })).toBeNull()
  })
})
