import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { requestError } from '../../api/errors.ts'
import type { EventType } from '../../api/resources.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import { translateMessage } from '../../i18n/translate.ts'
import { fakeApi, json, ME, profile, renderApp, signedInAs } from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType, schedule } from '../../test/fixtures.ts'
import {
  draftFromEventType,
  type EventTypeDraft,
  emptyDraft,
  serverErrors,
  toInput,
  toPatchInput,
  validateDraft,
} from './event-type-form.ts'
import { previewSuccessRedirect, SuccessRedirectEditor } from './SuccessRedirectEditor.tsx'

const settings: NonNullable<EventType['successRedirect']> = {
  url: 'https://target.example/thanks?flag&a;b#complete',
  parameters: ['start'],
  includeInviteePersonalData: false,
  allowEmbedParent: false,
}

const words = {
  en: {
    heading: 'After booking',
    url: /Continue to URL/,
    name: 'Invitee name',
    email: 'Invitee email',
    optIn: 'Allow sharing invitee name and email',
    embed: 'Allow embedded bookings to open the parent page',
    warning: /Warning: sharing invitee name or email makes them visible to the target site/,
    slug: 'Event type slug',
    start: 'Start time',
    end: 'End time',
    preview: 'Example continuation URL',
    save: 'Save changes',
    saved: 'Saved.',
    title: 'Title',
  },
  'zh-CN': {
    heading: '预约完成后',
    url: /继续访问的网址/,
    name: '受邀人姓名',
    email: '受邀人邮箱',
    optIn: '允许分享受邀人姓名和邮箱',
    embed: '允许嵌入预约跳转所在页面',
    warning: /警告：分享受邀人的姓名或邮箱后，目标网站及其分析工具将能看到这些信息/,
    slug: '活动类型链接标识',
    start: '开始时间',
    end: '结束时间',
    preview: '继续访问网址示例',
    save: '保存更改',
    saved: '已保存。',
    title: '标题',
  },
}

function setup(initial: EventType = eventType()) {
  let saved = initial
  const requests = fakeApi({
    ...signedInAs(ME),
    ...profile(),
    'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, saved),
    [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: ({ body }) => {
      saved = { ...saved, ...(body as Partial<EventType>) }
      return json(200, saved)
    },
  })
  return { requests, saved: () => saved, update: (next: EventType) => (saved = next) }
}

function Harness({ initial = emptyDraft() }: { initial?: EventTypeDraft }) {
  const [draft, setDraft] = useState(initial)
  return (
    <SuccessRedirectEditor
      draft={draft}
      errors={{}}
      set={(name, value) => setDraft((current) => ({ ...current, [name]: value }))}
    />
  )
}

describe.each(['en', 'zh-CN'] as const)('after-booking editor in %s', (language) => {
  it('previews the saved whitelist order when end is selected before start', async () => {
    chooseLanguage(language)
    const copy = words[language]
    setup()
    const user = userEvent.setup()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    await user.type(await screen.findByLabelText(copy.url), settings.url)
    await user.click(screen.getByLabelText(copy.end))
    await user.click(screen.getByLabelText(copy.start))
    expect(screen.getByLabelText(copy.preview).textContent).toBe(
      'https://target.example/thanks?flag&a;b&start=2030-01-15T10%3A00%3A00Z&end=2030-01-15T10%3A30%3A00Z#complete',
    )
  })

  it('round trips the redirect and clears it explicitly', async () => {
    chooseLanguage(language)
    const copy = words[language]
    const api = setup()
    const user = userEvent.setup()
    const view = renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    await user.type(await screen.findByLabelText(copy.url), settings.url)
    await user.click(screen.getByLabelText(copy.slug))
    await user.click(screen.getByLabelText(copy.start))
    await user.click(screen.getByLabelText(copy.optIn))
    await user.click(screen.getByLabelText(copy.name))
    await user.click(screen.getByLabelText(copy.email))
    await user.click(screen.getByLabelText(copy.embed))
    const preview = screen.getByLabelText(copy.preview).textContent ?? ''
    expect(preview).toContain('?flag&a;b&')
    const parsed = new URL(preview)
    expect(parsed.hash).toBe('#complete')
    expect(parsed.searchParams.get('inviteeEmail')).toBe('sam+demo@example.com')
    await user.click(screen.getByRole('button', { name: copy.save }))
    await screen.findByText(copy.saved)
    expect(api.saved().successRedirect).toEqual({
      ...settings,
      parameters: ['eventTypeSlug', 'start', 'inviteeName', 'inviteeEmail'],
      includeInviteePersonalData: true,
      allowEmbedParent: true,
    })
    view.unmount()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    expect((await screen.findByLabelText<HTMLInputElement>(copy.url)).value).toBe(settings.url)
    for (const label of [copy.slug, copy.start, copy.optIn, copy.name, copy.email, copy.embed])
      expect(screen.getByLabelText<HTMLInputElement>(label).checked).toBe(true)
    await user.clear(screen.getByLabelText(copy.url))
    await user.click(screen.getByRole('button', { name: copy.save }))
    await screen.findByText(copy.saved)
    expect(api.saved().successRedirect).toBeNull()
  })

  it('shows the warning before opt-in, connects it to controls and supports keyboard selection', async () => {
    chooseLanguage(language)
    const copy = words[language]
    // The standalone component uses the same source catalogues as the lazy admin app.
    setup()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const optIn = await screen.findByLabelText<HTMLInputElement>(copy.optIn)
    const warning = screen.getByText(copy.warning)
    expect(warning.compareDocumentPosition(optIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(optIn.getAttribute('aria-describedby')).toContain(warning.id)
    expect(optIn.checked).toBe(false)
    for (const label of [copy.name, copy.email])
      expect(screen.getByLabelText<HTMLInputElement>(label).disabled).toBe(true)
    optIn.focus()
    const user = userEvent.setup()
    await user.keyboard(' ')
    await user.tab()
    expect(document.activeElement).toBe(screen.getByLabelText(copy.name))
    await user.keyboard(' ')
    expect(screen.getByLabelText<HTMLInputElement>(copy.name).checked).toBe(true)
    await user.click(screen.getByLabelText(copy.email))
    await user.click(optIn)
    for (const label of [copy.name, copy.email]) {
      const control = screen.getByLabelText<HTMLInputElement>(label)
      expect(control.disabled).toBe(true)
      expect(control.checked).toBe(false)
    }
  })

  it('preserves a concurrent API update when only the title changes, including stale policy targets', async () => {
    chooseLanguage(language)
    const copy = words[language]
    const api = setup(eventType({ successRedirect: { ...settings, url: 'https://localhost/old' } }))
    const user = userEvent.setup()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const title = await screen.findByLabelText(copy.title)
    api.update({
      ...api.saved(),
      successRedirect: { ...settings, url: 'https://other.example/new' },
    })
    await user.clear(title)
    await user.type(title, 'New title')
    await user.click(screen.getByRole('button', { name: copy.save }))
    await screen.findByText(copy.saved)
    expect(
      api.requests.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body,
    ).not.toHaveProperty('successRedirect')
    expect(api.saved().successRedirect?.url).toBe('https://other.example/new')
    expect(screen.getByLabelText<HTMLInputElement>(copy.url).value).toBe(
      'https://other.example/new',
    )
  })

  it('preserves concurrent waitlist and redirect settings together and adopts both saved baselines', async () => {
    chooseLanguage(language)
    const copy = words[language]
    const api = setup(eventType({ waitlist: { enabled: true }, successRedirect: settings }))
    const user = userEvent.setup()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const title = await screen.findByLabelText(copy.title)
    api.update({
      ...api.saved(),
      waitlist: { enabled: false },
      successRedirect: { ...settings, url: 'https://other.example/new' },
    })
    await user.type(title, ' renamed')
    await user.click(screen.getByRole('button', { name: copy.save }))
    await screen.findByText(copy.saved)
    const firstPatch = api.requests.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body
    expect(firstPatch).not.toHaveProperty('waitlist')
    expect(firstPatch).not.toHaveProperty('successRedirect')
    expect(api.saved().waitlist).toEqual({ enabled: false })
    expect(screen.getByLabelText<HTMLInputElement>(copy.url).value).toBe(
      'https://other.example/new',
    )

    const waitlistName =
      language === 'en'
        ? 'Let invitees join a waitlist when no times are available'
        : '没有可预约时间时，允许受邀人加入候补名单'
    const waitlist = screen.getByRole<HTMLInputElement>('checkbox', { name: waitlistName })
    expect(waitlist.checked).toBe(false)
    await user.click(waitlist)
    await user.click(screen.getByRole('button', { name: copy.save }))
    await screen.findByText(copy.saved)
    const secondPatch = api.requests.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[1]?.body
    expect(secondPatch).toHaveProperty('waitlist', { enabled: true })
    expect(secondPatch).not.toHaveProperty('successRedirect')
    expect(api.saved().successRedirect?.url).toBe('https://other.example/new')
  })

  it('surfaces server URL validation inline and links its error summary to the field', async () => {
    chooseLanguage(language)
    const copy = words[language]
    fakeApi({
      ...signedInAs(ME),
      ...profile(),
      'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
      [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, eventType()),
      [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: () =>
        json(400, {
          error: 'invalid_success_redirect',
          message: 'successRedirect.url cannot use a local host',
          field: 'successRedirect.url',
        }),
    })
    const user = userEvent.setup()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const input = await screen.findByLabelText<HTMLInputElement>(copy.url)
    await user.type(input, 'https://localhost/thanks')
    await user.click(screen.getByRole('button', { name: copy.save }))
    const summary = await screen.findByRole('alert')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toContain('successRedirect.url-error')
    expect(summary.textContent).not.toContain('cannot use a local host')
    const link = within(summary).getByRole('link')
    expect(link.getAttribute('href')).toBe('#successRedirect.url')
    await user.click(link)
    expect(document.activeElement).toBe(input)
  })
})

describe('redirect draft and preview contracts', () => {
  it.each([false, true])(
    'keeps waitlist and redirect changes independent of their saved baselines (waitlist=%s)',
    (enabled) => {
      const baseline = draftFromEventType(
        eventType({ waitlist: { enabled }, successRedirect: settings }),
      )
      const waitlistEdit = { ...baseline, waitlistEnabled: !enabled }
      const onlyWaitlist = toPatchInput(waitlistEdit, baseline)
      expect(onlyWaitlist.waitlist).toEqual({ enabled: !enabled })
      expect(onlyWaitlist).not.toHaveProperty('successRedirect')
      const redirectEdit = { ...baseline, allowEmbedParent: true }
      const onlyRedirect = toPatchInput(redirectEdit, baseline)
      expect(onlyRedirect.successRedirect).toEqual({ ...settings, allowEmbedParent: true })
      expect(onlyRedirect).not.toHaveProperty('waitlist')
      const both = toPatchInput({ ...waitlistEdit, allowEmbedParent: true }, baseline)
      expect(both.waitlist).toEqual({ enabled: !enabled })
      expect(both.successRedirect).toEqual({ ...settings, allowEmbedParent: true })
      const reverted = toPatchInput({ ...waitlistEdit, waitlistEnabled: enabled }, baseline)
      expect(reverted).not.toHaveProperty('waitlist')
      expect(reverted).not.toHaveProperty('successRedirect')
    },
  )

  it('keeps notification and redirect changes independent of their editor session baselines', () => {
    const baseline = draftFromEventType(eventType({ successRedirect: settings }))
    const onlyRedirect = toPatchInput({ ...baseline, allowEmbedParent: true }, baseline)
    expect(onlyRedirect).not.toHaveProperty('notifications')
    expect(onlyRedirect.successRedirect?.allowEmbedParent).toBe(true)
    const notifications = { reminders: [], followUps: [] }
    const onlyNotifications = toPatchInput({ ...baseline, notifications }, baseline)
    expect(onlyNotifications).not.toHaveProperty('successRedirect')
    expect(onlyNotifications.notifications).toEqual(notifications)
    const both = toPatchInput({ ...baseline, notifications, allowEmbedParent: true }, baseline)
    expect(both.notifications).toEqual(notifications)
    expect(both.successRedirect?.allowEmbedParent).toBe(true)
  })

  it('sends all configuration on create and only changed configuration on PATCH', () => {
    expect(toInput(emptyDraft())).not.toHaveProperty('successRedirect')
    const original = draftFromEventType(eventType({ successRedirect: settings }))
    expect(toInput(original).successRedirect).toEqual(settings)
    expect(toPatchInput({ ...original, title: 'Changed' }, original)).not.toHaveProperty(
      'successRedirect',
    )
    const edited = { ...original, allowEmbedParent: true }
    expect(toPatchInput(edited, original).successRedirect).toEqual({
      ...settings,
      allowEmbedParent: true,
    })
    expect(toPatchInput({ ...edited, allowEmbedParent: false }, original)).not.toHaveProperty(
      'successRedirect',
    )
    expect(
      toPatchInput({ ...original, successRedirectUrl: '' }, original).successRedirect,
    ).toBeNull()
  })

  it('leaves destination validation to the service and preserves the input exactly', () => {
    const draft = {
      ...draftFromEventType(eventType()),
      successRedirectUrl: ' http://localhost/invalid ',
    }
    expect(validateDraft(draft)).toEqual({})
    expect(toInput(draft).successRedirect?.url).toBe(draft.successRedirectUrl)
  })

  it.each([
    'successRedirect',
    'successRedirect.url',
    'successRedirect.parameters',
    'successRedirect.includeInviteePersonalData',
    'successRedirect.allowEmbedParent',
  ])('maps stable server error field %s in both languages', (field) => {
    const error = requestError(400, {
      error: 'invalid_success_redirect',
      message: 'Server detail',
      field,
    })
    expect(error.field).toBe(field)
    const mapped = serverErrors(error, emptyDraft())
    expect(Object.keys(mapped.fields)).toEqual([field])
    const message = mapped.fields[field]
    expect(translateMessage('zh-CN', message)).toMatch(/\p{Script=Han}/u)
    expect(translateMessage('zh-CN', message)).not.toBe(translateMessage('en', message))
  })

  it('encodes selected sample values, preserves existing query text and fragment, and excludes personal data without opt-in', () => {
    const draft = {
      ...emptyDraft(),
      successRedirectUrl: settings.url,
      successRedirectParameters: ['hostName', 'inviteeEmail'] as const,
    }
    const withMutableParameters = {
      ...draft,
      successRedirectParameters: [...draft.successRedirectParameters],
    }
    expect(previewSuccessRedirect(withMutableParameters)).toBe(
      'https://target.example/thanks?flag&a;b&hostName=Alex+Chen#complete',
    )
    const preview =
      previewSuccessRedirect({ ...withMutableParameters, includeInviteePersonalData: true }) ?? ''
    expect(preview).toContain('inviteeEmail=sam%2Bdemo%40example.com')
    expect(new URL(preview).searchParams.get('inviteeEmail')).toBe('sam+demo@example.com')
    expect(previewSuccessRedirect(emptyDraft())).toBeNull()
  })

  it('renders a non-live text preview associated with the URL field', async () => {
    render(
      <Harness
        initial={{ ...emptyDraft(), successRedirectUrl: 'https://target.example/?query=<script>' }}
      />,
    )
    const preview = screen.getByLabelText('Example continuation URL')
    expect(preview.tagName).toBe('OUTPUT')
    expect(preview.getAttribute('aria-live')).toBe('off')
    expect(preview.getAttribute('for')).toBe(screen.getByLabelText(/Continue to URL/).id)
    expect(preview.querySelector('a, script')).toBeNull()
    await waitFor(() => expect(preview.textContent).toContain('query=%3Cscript%3E'))
  })
})
