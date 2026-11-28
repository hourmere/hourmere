import type { InterfaceLanguage } from '@hourmere/core/language'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../api/client.ts'
import { common as english } from '../i18n/catalogues/en/common.ts'
import { holdTestCatalogue } from '../i18n/catalogues.fixture.ts'
import { translateMessage } from '../i18n/translate.ts'
import { fakeApi, json, later, renderApp } from '../test/fake-api.tsx'
import { accessibleNameParts } from '../test/public-fixtures.ts'

vi.mock('./env.ts', async (original) => ({
  ...(await original<typeof import('./env.ts')>()),
  detectTimeZone: () => 'America/New_York',
}))

const endpoint = (action: string) => `POST /api/v1/public/meeting-polls/${action}`
const token = 'fixture-voter-capability'
const pollId = '00000000-0000-4000-8000-000000000001'
const slotA = '00000000-0000-4000-8000-000000000002'
const slotB = '00000000-0000-4000-8000-000000000003'
const voter: Schemas['MeetingPollVoter'] = {
  pollId,
  voterId: '00000000-0000-4000-8000-000000000004',
  name: 'Ada',
  email: 'ada@example.invalid',
  timeZone: 'America/New_York',
  locale: 'en',
  status: 'verified',
  deadlineAt: '2027-11-10T00:00:00Z',
}
const ballot: Schemas['MeetingPollOwnBallot'] = {
  voter,
  ballotRevision: 0,
  submittedAt: null,
  consentedAt: null,
  votes: [],
  responses: {},
}
const poll: Schemas['PublicMeetingPoll'] = {
  id: pollId,
  title: 'Planning together',
  durationMinutes: 30,
  displayTimeZone: 'Asia/Tokyo',
  admissionMode: 'public_link',
  visibility: 'private',
  status: 'open',
  deadlineAt: voter.deadlineAt,
  readOnly: false,
  candidates: [
    { id: slotA, position: 0, startAt: '2027-11-07T05:30:00Z', endAt: '2027-11-07T06:00:00Z' },
    { id: slotB, position: 1, startAt: '2027-11-07T06:30:00Z', endAt: '2027-11-07T07:00:00Z' },
  ],
  chosenSlotId: null,
  questions: [],
  locations: null,
  allowGuests: true,
  ownBallot: ballot,
  counts: null,
}
const saved: Schemas['MeetingPollOwnBallot'] = {
  ...ballot,
  ballotRevision: 1,
  submittedAt: '2027-10-01T00:00:00Z',
  consentedAt: '2027-10-01T00:00:00Z',
  votes: [
    { slotId: slotA, value: 'yes' },
    { slotId: slotB, value: 'if_need_be' },
  ],
}
const withdrawn: Schemas['MeetingPollOwnBallot'] = {
  ...ballot,
  voter: { ...voter, status: 'withdrawn' },
  ballotRevision: 2,
}
function language(locale: InterfaceLanguage) {
  localStorage.setItem('hourmere-language', locale)
  localStorage.setItem('hourmere-visitor-time-zone', 'America/New_York')
  return (text: string) => {
    const key = Object.entries(english).find(
      ([key, value]) => key.startsWith('meetingPoll.') && value === text,
    )?.[0]
    if (!key) throw new Error(`Missing poll translation for ${text}`)
    return translateMessage(locale, key)
  }
}
async function chooseBallot(t: (text: string) => string, keyboard = false) {
  const user = userEvent.setup()
  const groups = screen
    .getAllByRole('group')
    .filter((group) => within(group).queryAllByRole('radio').length)
  const first = within(groups[0] as HTMLElement).getByRole('radio', { name: t('Yes') })
  if (keyboard) {
    first.focus()
    await user.keyboard(' ')
    expect(document.activeElement).toBe(first)
    await user.keyboard('{ArrowRight}')
    expect(
      (
        within(groups[0] as HTMLElement).getByRole('radio', {
          name: t('If need be'),
        }) as HTMLInputElement
      ).checked,
    ).toBe(true)
    await user.keyboard('{ArrowLeft}')
  } else await user.click(first)
  await user.click(within(groups[1] as HTMLElement).getByRole('radio', { name: t('If need be') }))
  await user.click(screen.getByRole('checkbox'))
  return user
}

for (const locale of ['en', 'zh-CN', 'fr'] as const) {
  describe(`meeting poll public page in ${locale}`, () => {
    it('keeps loading neutral and uses POST body capabilities without session discovery', async () => {
      const t = language(locale)
      const pending = later()
      const api = fakeApi({ [endpoint('read')]: () => pending.response })
      renderApp(`/poll/voter#${token}`)
      expect(screen.queryByRole('radio')).toBeNull()
      expect(screen.queryByText(t('This poll is unavailable.'))).toBeNull()
      await pending.answer(json(200, poll))
      await screen.findByRole('heading', { name: poll.title })
      expect(api.to(endpoint('read')).map((call) => call.body)).toEqual([{ token }])
      expect(
        api.calls.every((call) => !call.path.includes(token) && !call.path.includes('?')),
      ).toBe(true)
      expect(api.calls.some((call) => /\/me$|\/api\/auth/.test(call.path))).toBe(false)
      expect(
        api.calls.filter(
          (call) => call.path.includes('/meeting-polls/') && !call.path.endsWith('/read'),
        ),
      ).toHaveLength(0)
    })

    it.each(['unknown', 'removed', 'expired'])(
      'shows the uniform unavailable state for %s credentials',
      async () => {
        const t = language(locale)
        fakeApi({
          [endpoint('read')]: () =>
            json(404, { error: 'poll_not_found', message: 'private diagnostics' }),
        })
        renderApp(`/poll/voter#${token}`)
        await screen.findByText(t('This poll is unavailable.'))
        expect(screen.queryByRole('radio')).toBeNull()
        expect(document.body.textContent).not.toContain('private diagnostics')
      },
    )

    it('enrols with name and email then shows uniform check-email guidance', async () => {
      const t = language(locale)
      const mixedName = 'ليلى (Layla) — נועה'
      const api = fakeApi({
        [endpoint('read')]: () => json(200, { ...poll, ownBallot: null }),
        [endpoint('enroll')]: () => json(202, { accepted: true }),
      })
      renderApp(`/poll#${token}`)
      const user = userEvent.setup()
      const name = await screen.findByRole('textbox', { name: t('Your name') })
      expect(name.getAttribute('dir')).toBe('auto')
      await user.type(name, mixedName)
      await user.type(screen.getByLabelText(t('Email address')), 'grace@example.invalid')
      await user.click(screen.getByRole('button', { name: t('Send verification email') }))
      await screen.findByRole('heading', { name: t('Check your email') })
      expect(api.to(endpoint('enroll'))[0]?.body).toEqual({
        publicToken: token,
        name: mixedName,
        email: 'grace@example.invalid',
        timeZone: 'America/New_York',
        locale,
      })
    })

    it('verifies only on explicit action and hands the replacement token to subsequent reads', async () => {
      const t = language(locale)
      let verified = false
      const api = fakeApi({
        [endpoint('read')]: () => json(200, verified ? poll : { ...poll, ownBallot: null }),
        [endpoint('verify')]: () => {
          verified = true
          return json(200, { voter, votingToken: 'replacement-capability' })
        },
      })
      renderApp(`/poll/voter#${token}`)
      const verify = await screen.findByRole('button', { name: t('Verify my email') })
      expect(api.to(endpoint('verify'))).toHaveLength(0)
      expect(screen.getAllByRole('radio').every((radio) => radio.matches(':disabled'))).toBe(true)
      await userEvent.click(verify)
      await screen.findByRole('button', { name: t('Save ballot') })
      expect(api.to(endpoint('verify'))[0]?.body).toEqual({ token })
      expect(api.to(endpoint('read')).at(-1)?.body).toEqual({ token: 'replacement-capability' })
      expect(api.calls.every((call) => !call.path.includes('capability'))).toBe(true)
    })

    it('saves, edits and withdraws only the visitor ballot, announcing each result', async () => {
      const t = language(locale)
      let current = ballot
      const api = fakeApi({
        [endpoint('read')]: () => json(200, { ...poll, ownBallot: current }),
        [endpoint('vote')]: () => {
          current = { ...saved, ballotRevision: current.ballotRevision + 1 }
          return json(200, current)
        },
        [endpoint('withdraw')]: () => {
          current = { ...withdrawn, ballotRevision: 3 }
          return json(200, current)
        },
      })
      renderApp(`/poll/voter#${token}`)
      await screen.findByRole('button', { name: t('Save ballot') })
      const user = await chooseBallot(t, true)
      await user.click(screen.getByRole('button', { name: t('Save ballot') }))
      await screen.findByText(t('Your ballot is saved.'))
      expect(api.to(endpoint('vote'))[0]?.body).toMatchObject({
        token,
        consent: true,
        expectedBallotRevision: 0,
        votes: saved.votes,
        timeZone: 'America/New_York',
        locale,
      })
      await user.click(screen.getByRole('button', { name: t('Save ballot') }))
      await screen.findByText(t('Your changes are saved.'))
      expect(api.to(endpoint('vote'))[1]?.body).toMatchObject({ expectedBallotRevision: 1 })
      await user.click(screen.getByRole('button', { name: t('Withdraw my ballot') }))
      await screen.findAllByText(
        t('Your ballot is withdrawn. Your answers have been removed and poll emails have stopped.'),
      )
      expect(api.to(endpoint('withdraw'))[0]?.body).toEqual({ token, expectedBallotRevision: 2 })
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
      expect(
        screen.getAllByRole('radio').every((radio) => !(radio as HTMLInputElement).checked),
      ).toBe(true)
    })

    it.each(['closed', 'canceled', 'scheduled'] as const)(
      'renders %s as read-only with the own saved ballot',
      async (status) => {
        const t = language(locale)
        fakeApi({
          [endpoint('read')]: () =>
            json(200, {
              ...poll,
              ownBallot: saved,
              status,
              readOnly: true,
              chosenSlotId: status === 'scheduled' ? slotA : null,
            }),
        })
        renderApp(`/poll/voter#${token}`)
        await screen.findByRole('heading', { name: poll.title })
        expect(screen.queryByRole('button', { name: t('Save ballot') })).toBeNull()
        expect(screen.queryByRole('button', { name: t('Withdraw my ballot') })).toBeNull()
        expect(document.body.textContent).toContain(t('Yes'))
        expect(screen.getAllByRole('radio').every((radio) => radio.matches(':disabled'))).toBe(true)
        expect(
          screen.getAllByRole('radio').filter((radio) => (radio as HTMLInputElement).checked),
        ).toHaveLength(2)
      },
    )

    it('recovers access uniformly without exposing credentials', async () => {
      const t = language(locale)
      const api = fakeApi({ [endpoint('recover')]: () => json(202, { accepted: true }) })
      renderApp('/poll/recover')
      const user = userEvent.setup()
      await user.type(await screen.findByLabelText(t('Poll ID')), pollId)
      await user.type(screen.getByLabelText(t('Email address')), 'ada@example.invalid')
      await user.click(screen.getByRole('button', { name: t('Send access email') }))
      await screen.findByRole('heading', { name: t('Check your email') })
      expect(api.to(endpoint('recover'))[0]?.body).toEqual({ pollId, email: 'ada@example.invalid' })
    })

    it('requires explicit reminder unsubscribe and never reads or verifies a ballot', async () => {
      const t = language(locale)
      const api = fakeApi({
        [endpoint('reminder-opt-out')]: () =>
          json(200, { pollId, optedOutAt: '2027-10-01T00:00:00Z' }),
      })
      renderApp(`/poll/reminder-opt-out#${token}`)
      const button = await screen.findByRole('button', { name: t('Stop reminders') })
      expect(api.to(endpoint('reminder-opt-out'))).toHaveLength(0)
      await userEvent.click(button)
      await screen.findByText(t('Reminders for this poll are stopped.'))
      expect(api.to(endpoint('reminder-opt-out'))[0]?.body).toEqual({ token })
      expect(api.to(endpoint('read'))).toHaveLength(0)
      expect(api.to(endpoint('verify'))).toHaveLength(0)
    })
  })
}

describe('meeting poll language while a catalogue downloads', () => {
  it('sends the requested language when enrolling with English labels', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-DE'])
    const download = holdTestCatalogue('de', 'common')
    const api = fakeApi({
      [endpoint('read')]: () => json(200, { ...poll, ownBallot: null }),
      [endpoint('enroll')]: () => json(202, { accepted: true }),
    })
    renderApp(`/poll#${token}`)
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('Your name'), 'Ada')
    await user.type(screen.getByLabelText('Email address'), 'ada@example.invalid')
    await user.click(screen.getByRole('button', { name: 'Send verification email' }))
    await screen.findByRole('heading', { name: 'Check your email' })
    expect(download).toHaveBeenCalledOnce()
    expect(api.to(endpoint('enroll'))[0]?.body).toMatchObject({ locale: 'de' })
  })

  it('sends the requested language when voting with English labels', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-DE'])
    const download = holdTestCatalogue('de', 'common')
    const api = fakeApi({
      [endpoint('read')]: () => json(200, poll),
      [endpoint('vote')]: () => json(200, saved),
    })
    renderApp(`/poll/voter#${token}`)
    const save = await screen.findByRole('button', { name: 'Save ballot' })
    const user = await chooseBallot((text) => text)
    await user.click(save)
    await screen.findByText('Your ballot is saved.')
    expect(download).toHaveBeenCalledOnce()
    expect(api.to(endpoint('vote'))[0]?.body).toMatchObject({ locale: 'de' })
  })
})

describe('meeting poll privacy and ballot boundaries', () => {
  it.each([null, { ...ballot, voter: { ...voter, status: 'invited' as const } }, withdrawn])(
    'does not display aggregate counts without an active verified voter (%j)',
    async (ownBallot) => {
      language('en')
      // The read service sends no counts to public, unverified or withdrawn readers.
      fakeApi({
        [endpoint('read')]: () =>
          json(200, { ...poll, visibility: 'aggregate', ownBallot, counts: null }),
      })
      renderApp(`/poll/voter#${token}`)
      await screen.findByRole('heading', { name: poll.title })
      expect(document.querySelector('.poll-counts')).toBeNull()
    },
  )

  it('does not accept query-string credentials', async () => {
    language('en')
    const api = fakeApi({})
    renderApp(`/poll/voter?token=${token}`)
    await screen.findByText('This poll is unavailable.')
    expect(api.to(endpoint('read'))).toHaveLength(0)
    expect(screen.getByRole('main').textContent).not.toContain(token)
  })

  it('prevents duplicate writes and announces progress while saving', async () => {
    const t = language('en')
    const pending = later()
    const api = fakeApi({
      [endpoint('read')]: () => json(200, poll),
      [endpoint('vote')]: () => pending.response,
    })
    renderApp(`/poll/voter#${token}`)
    await screen.findByRole('button', { name: 'Save ballot' })
    await chooseBallot(t)
    const form = screen.getByRole('button', { name: 'Save ballot' }).closest('form')
    if (!form) throw new Error('Expected ballot form')
    fireEvent.submit(form)
    fireEvent.submit(form)
    await waitFor(() => expect(api.to(endpoint('vote'))).toHaveLength(1))
    expect(screen.getByRole('button', { name: 'Save ballot' }).matches(':disabled')).toBe(true)
    await pending.answer(json(200, saved))
    const message = await screen.findByText('Your ballot is saved.')
    expect(message.closest('[role="status"], [aria-live="polite"]')).not.toBeNull()
  })

  it.each(['poll_changed', 'network'])(
    'requires an explicit reread after %s without replaying a write',
    async (failure) => {
      const t = language('en')
      let reads = 0
      const api = fakeApi({
        [endpoint('read')]: () => json(200, { ...poll, ownBallot: ++reads > 1 ? saved : ballot }),
        [endpoint('vote')]: () => {
          if (failure === 'network') throw new TypeError('network lost')
          return json(409, { error: 'poll_changed', message: 'private diagnostics' })
        },
      })
      renderApp(`/poll/voter#${token}`)
      await screen.findByRole('button', { name: 'Save ballot' })
      const user = await chooseBallot(t)
      await user.click(screen.getByRole('button', { name: 'Save ballot' }))
      const reload = await screen.findByRole('button', { name: 'Reload ballot' })
      expect(api.to(endpoint('vote'))).toHaveLength(1)
      expect(document.body.textContent).not.toContain('private diagnostics')
      const submit = screen.queryByRole('button', { name: 'Save ballot' })
      expect(submit === null || submit.matches(':disabled')).toBe(true)
      await user.click(reload)
      await waitFor(() => expect(api.to(endpoint('read'))).toHaveLength(2))
      expect(api.to(endpoint('vote'))).toHaveLength(1)
    },
  )

  it.each([401, 403, 429, 503])(
    'renders read HTTP %i neutrally with a manual retry',
    async (status) => {
      language('en')
      const api = fakeApi({
        [endpoint('read')]: () =>
          json(status, {
            error: status === 429 ? 'rate_limited' : 'unavailable',
            message: 'secret detail',
          }),
      })
      renderApp(`/poll/voter#${token}`)
      await screen.findByRole('alert')
      expect(screen.queryByText('This poll is unavailable.')).toBeNull()
      expect(screen.queryByRole('radio')).toBeNull()
      expect(document.body.textContent).not.toContain('secret detail')
      expect(api.to(endpoint('read'))).toHaveLength(1)
    },
  )

  it('shows DST offsets and changes local dates without changing slot IDs or selected votes', async () => {
    const t = language('en')
    const api = fakeApi({
      [endpoint('read')]: () => json(200, poll),
      [endpoint('vote')]: () => json(200, saved),
    })
    renderApp(`/poll/voter#${token}`)
    await screen.findByRole('button', { name: 'Save ballot' })
    const legends = () =>
      [...document.querySelectorAll('fieldset legend')].map((legend) => legend.textContent ?? '')
    expect(legends().join(' ')).toContain('GMT-04:00')
    expect(legends().join(' ')).toContain('GMT-05:00')
    const user = await chooseBallot(t)
    await user.selectOptions(screen.getByLabelText('Time zone'), 'America/Los_Angeles')
    expect(legends().join(' ')).toMatch(/November 6|Nov 6/)
    expect(
      screen.getAllByRole('radio').filter((radio) => (radio as HTMLInputElement).checked),
    ).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Save ballot' }))
    await screen.findByText('Your ballot is saved.')
    expect(api.to(endpoint('vote'))[0]?.body).toMatchObject({
      votes: saved.votes,
      timeZone: 'America/Los_Angeles',
    })
  })

  it('requires renewed consent for reactivation and sends the withdrawn revision', async () => {
    const t = language('en')
    const api = fakeApi({
      [endpoint('read')]: () => json(200, { ...poll, ownBallot: withdrawn }),
      [endpoint('vote')]: () => json(200, { ...saved, ballotRevision: 3 }),
    })
    renderApp(`/poll/voter#${token}`)
    await screen.findByRole('heading', { name: poll.title })
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    const user = await chooseBallot(t)
    await user.click(screen.getByRole('button', { name: 'Submit a new ballot' }))
    await waitFor(() => expect(api.to(endpoint('vote'))).toHaveLength(1))
    expect(api.to(endpoint('vote'))[0]?.body).toMatchObject({
      consent: true,
      expectedBallotRevision: 2,
      votes: saved.votes,
    })
  })
})

it.each(['en', 'zh-CN'] as const)(
  'validates and submits isolated mixed-direction answers for the visitor only in %s',
  async (locale) => {
    const t = language(locale)
    const title = '✨ 42 (اجتماع) Planning'
    const topicLabel = 'ما الموضوع؟ (Discussion topic)'
    const choicesLabel = 'ציוד (Equipment)'
    const equipment = 'מחשב (Laptop)'
    const notes = 'راجع agenda@example.invalid\n\nSee https://room.example.invalid/42 (שלום).'
    const responses = { topic: notes, choices: [equipment] }
    const api = fakeApi({
      [endpoint('read')]: () =>
        json(200, {
          ...poll,
          title,
          questions: [
            { id: 'topic', type: 'long_text', label: topicLabel, required: true },
            {
              id: 'choices',
              type: 'multi_select',
              label: choicesLabel,
              required: true,
              options: [equipment, 'عارض (Projector)'],
            },
          ],
        }),
      [endpoint('vote')]: () => json(200, { ...saved, responses }),
    })
    renderApp(`/poll/voter#${token}`)
    expect((await screen.findByRole('heading', { name: title })).dir).toBe('auto')
    expect(document.documentElement.dir).toBe('ltr')
    const submit = await screen.findByRole('button', { name: t('Save ballot') })
    const form = submit.closest('form')
    if (!form) throw new Error('Expected ballot form')
    fireEvent.submit(form)
    await screen.findByRole('alert')
    expect(api.to(endpoint('vote'))).toHaveLength(0)
    const user = userEvent.setup()
    const groups = screen
      .getAllByRole('group')
      .filter((group) => within(group).queryAllByRole('radio').length)
    await user.click(within(groups[0] as HTMLElement).getByRole('radio', { name: t('Yes') }))
    await user.click(within(groups[1] as HTMLElement).getByRole('radio', { name: t('If need be') }))
    const required = t('Required')
    const topic = screen.getByRole('textbox', {
      name: accessibleNameParts([topicLabel, '·', required]),
    })
    expect(topic.dir).toBe('auto')
    expect(screen.getByText(topicLabel).tagName).toBe('BDI')
    fireEvent.change(topic, { target: { value: notes } })
    const choices = screen.getByRole('group', {
      name: accessibleNameParts([choicesLabel, '·', required]),
    })
    expect(within(choices).getByText(choicesLabel).tagName).toBe('BDI')
    const option = within(choices).getByRole('checkbox', { name: equipment })
    expect(option.closest('label')?.querySelector('bdi')?.textContent).toBe(equipment)
    await user.click(option)
    fireEvent.submit(form)
    expect(api.to(endpoint('vote'))).toHaveLength(0)
    const consent = translateMessage(locale, 'meetingPoll.consent')
    await user.click(screen.getByRole('checkbox', { name: consent }))
    await user.click(submit)
    await screen.findByText(t('Your ballot is saved.'))
    expect(api.to(endpoint('vote'))[0]?.body).toMatchObject({
      responses,
      consent: true,
    })
  },
)

it.each(['en', 'zh-CN', 'fr'] as const)(
  'uses localized option plurals and verified aggregate counts in %s',
  async (locale) => {
    language(locale)
    fakeApi({
      [endpoint('read')]: () =>
        json(200, {
          ...poll,
          visibility: 'aggregate',
          counts: [{ slotId: slotA, yes: 1, ifNeedBe: 0, no: 2 }],
        }),
    })
    renderApp(`/poll/voter#${token}`)
    await screen.findByRole('heading', { name: poll.title })
    expect(
      screen.getByText(
        translateMessage(locale, { key: 'meetingPoll.optionsOther', values: { count: 2 } }),
      ),
    ).toBeDefined()
    const count = document.querySelector('.poll-counts')
    expect(count?.textContent).toContain(
      translateMessage(locale, { key: 'meetingPoll.countYes', values: { count: 1 } }),
    )
    expect(count?.textContent).toContain(
      translateMessage(locale, { key: 'meetingPoll.countIfNeedBe', values: { count: 0 } }),
    )
    expect(count?.textContent).toContain(
      translateMessage(locale, { key: 'meetingPoll.countNo', values: { count: 2 } }),
    )
  },
)

for (const locale of ['en', 'zh-CN', 'fr'] as const) {
  it.each([
    [429, 'rate_limited', 'Too many requests. Please wait before trying again.'],
    [400, 'invalid_voter', 'Check your entries and try again.'],
    [409, 'poll_full', 'This poll is full. You can still recover an existing link.'],
  ] as const)(
    `localizes neutral enrollment error %s in ${locale}`,
    async (status, error, message) => {
      const t = language(locale)
      const api = fakeApi({
        [endpoint('read')]: () => json(200, { ...poll, ownBallot: null }),
        [endpoint('enroll')]: () =>
          json(status, { error, message: 'private@example.invalid already enrolled' }),
      })
      renderApp(`/poll#${token}`)
      const user = userEvent.setup()
      await user.type(await screen.findByLabelText(t('Your name')), 'Grace')
      await user.type(screen.getByLabelText(t('Email address')), 'grace@example.invalid')
      await user.click(screen.getByRole('button', { name: t('Send verification email') }))
      expect((await screen.findByRole('alert')).textContent).toBe(t(message))
      expect(screen.queryByRole('heading', { name: t('Check your email') })).toBeNull()
      expect(document.body.textContent).not.toContain('private@example.invalid')
      expect(api.to(endpoint('enroll'))).toHaveLength(1)
    },
  )
}

it('lets an unverified invitee withdraw explicitly without verifying or voting', async () => {
  language('en')
  const api = fakeApi({
    [endpoint('read')]: () =>
      json(200, { ...poll, ownBallot: { ...ballot, voter: { ...voter, status: 'invited' } } }),
    [endpoint('withdraw')]: () => json(200, { ...withdrawn, ballotRevision: 1 }),
  })
  renderApp(`/poll/voter#${token}`)
  const button = await screen.findByRole('button', { name: 'Withdraw my ballot' })
  button.focus()
  await userEvent.keyboard('{Enter}')
  await screen.findByRole('button', { name: 'Submit a new ballot' })
  expect(api.to(endpoint('withdraw')).map((call) => call.body)).toEqual([
    { token, expectedBallotRevision: 0 },
  ])
  expect(api.to(endpoint('verify'))).toHaveLength(0)
  expect(api.to(endpoint('vote'))).toHaveLength(0)
})

it.each(['/poll/voter/', '/POLL/VOTER', '/poll/%76oter'])(
  'keeps explicit voter semantics for router-equivalent path %s',
  async (path) => {
    language('en')
    const api = fakeApi({ [endpoint('read')]: () => json(200, { ...poll, ownBallot: null }) })
    renderApp(`${path}#${token}`)
    await screen.findByRole('button', { name: 'Verify my email' })
    expect(screen.queryByRole('button', { name: 'Send verification email' })).toBeNull()
    expect(api.to(endpoint('verify'))).toHaveLength(0)
  },
)

it('keeps the trailing-slash reminder opt-out entry purpose-limited', async () => {
  language('en')
  const api = fakeApi({
    [endpoint('reminder-opt-out')]: () => json(200, { pollId, optedOutAt: '2027-10-01T00:00:00Z' }),
  })
  renderApp(`/poll/reminder-opt-out/#${token}`)
  await userEvent.click(await screen.findByRole('button', { name: 'Stop reminders' }))
  await screen.findByText('Reminders for this poll are stopped.')
  expect(api.to(endpoint('read'))).toHaveLength(0)
  expect(api.to(endpoint('reminder-opt-out'))[0]?.body).toEqual({ token })
})

it('keeps trailing-slash recovery available without a capability', async () => {
  language('en')
  fakeApi({})
  renderApp('/poll/recover/')
  await screen.findByLabelText('Poll ID')
  expect(screen.getByRole('button', { name: 'Send access email' })).toBeDefined()
  expect(screen.queryByText('This poll is unavailable.')).toBeNull()
})

it('clears the saved announcement when the visitor changes an unsaved answer', async () => {
  language('en')
  const api = fakeApi({ [endpoint('read')]: () => json(200, { ...poll, ownBallot: saved }) })
  renderApp(`/poll/voter#${token}`)
  await screen.findByText('Your ballot is saved.')
  const first = screen
    .getAllByRole('group')
    .find((group) => within(group).queryAllByRole('radio').length)
  if (!first) throw new Error('Expected ballot choices')
  await userEvent.click(within(first).getByRole('radio', { name: 'No' }))
  expect(screen.queryByText('Your ballot is saved.')).toBeNull()
  expect(api.to(endpoint('vote'))).toHaveLength(0)
})
