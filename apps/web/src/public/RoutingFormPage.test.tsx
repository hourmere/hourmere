import { interfaceLanguages } from '@hourmere/core/language'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../api/client.ts'
import { goTo } from '../browser.ts'
import { commonCatalogues } from '../i18n/common.ts'
import { fakeApi, json, later, renderApp } from '../test/fake-api.tsx'

vi.mock('../browser.ts', async (original) => ({
  ...(await original<typeof import('../browser.ts')>()),
  goTo: vi.fn(),
}))

const path = '/route/ada/intro'
const endpoint = '/api/v1/public/-/routing/ada/intro'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const [name, email, choice, removedChoice, removedQuestion, changedType, newQuestion] = [
  id(1),
  id(2),
  id(3),
  id(4),
  id(5),
  id(6),
  id(7),
] as const
const [chosen, another] = [id(10), id(11)] as const
const options = [
  { id: chosen, label: 'Sales' },
  { id: another, label: 'Support' },
]
const form: Schemas['PublicRoutingForm'] = {
  versionId: id(20),
  title: 'Find the right meeting',
  description: 'Tell us a little about your request.',
  questions: [
    { id: name, type: 'short_text', label: 'Company', required: true },
    { id: email, type: 'email', label: 'Work email', required: true },
    { id: choice, type: 'select', label: 'Department', required: false, options },
  ],
}
const enabled = { 'GET /api/v1/instance': () => json(200, { routingFormsEnabled: true }) }
const message = { kind: 'message', message: '<strong>We will be in touch.</strong>' }

describe('the public routing form', () => {
  it('uses keyboard order, native labels and required states, and announces localized field errors', async () => {
    const user = userEvent.setup()
    const api = fakeApi({ ...enabled, [`GET ${endpoint}`]: () => json(200, form) })
    renderApp(path)
    const heading = await screen.findByRole('heading', { name: form.title })
    const company = screen.getByRole('textbox', { name: 'Company' })
    const address = screen.getByRole('textbox', { name: 'Work email' })
    const department = screen.getByRole('combobox', { name: 'Department' })
    const button = screen.getByRole('button', { name: 'Continue' })
    // Focus moves to the heading in an effect after it renders; under load that can lag the heading.
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(company.hasAttribute('required')).toBe(true)
    expect(address.getAttribute('type')).toBe('email')
    expect(screen.getByRole('combobox', { name: 'Department', description: 'Optional' })).toBe(
      department,
    )
    expect(within(department).getByRole('option', { name: 'Select an option' })).toBeDefined()
    for (const control of [company, address, department, button]) {
      await user.tab()
      expect(document.activeElement).toBe(control)
    }
    await user.keyboard('{Enter}')
    expect((await screen.findByRole('alert')).textContent).toBe('Review the highlighted answers.')
    expect(document.activeElement).toBe(company)
    expect(company.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('textbox', { name: 'Company', description: 'Enter an answer.' })).toBe(
      company,
    )
    fireEvent.change(company, { target: { value: 'x'.repeat(501) } })
    expect(
      screen.getByRole('textbox', {
        name: 'Company',
        description: 'Enter 500 characters or fewer.',
      }),
    ).toBe(company)
    fireEvent.change(company, { target: { value: 'Acme\u202e' } })
    expect(
      screen.getByRole('textbox', {
        name: 'Company',
        description: 'Remove unsupported characters from your answer.',
      }),
    ).toBe(company)
    await user.clear(company)
    await user.type(company, 'Acme')
    expect(company.hasAttribute('aria-invalid')).toBe(false)
    await user.tab()
    await user.type(address, 'not-an-email')
    expect(
      screen.getByRole('textbox', {
        name: 'Work email',
        description: 'Enter a valid email address.',
      }),
    ).toBe(address)
    expect(api.to(`POST ${endpoint}/route`)).toHaveLength(0)
  })

  it('sends answers only in the POST body and displays outcome text literally', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      ...enabled,
      [`GET ${endpoint}`]: () => json(200, form),
      [`POST ${endpoint}/route`]: () => json(200, message),
    })
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const logs = (['log', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level))
    const url = window.location.href
    renderApp(path)
    const privateAnswer = 'Acme private request'
    await user.type(await screen.findByLabelText('Company'), ` ${privateAnswer} `)
    await user.type(screen.getByLabelText('Work email'), 'invitee@example.invalid')
    await user.selectOptions(screen.getByLabelText('Department'), 'Sales')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('heading', { name: 'Thank you' })).toBe(document.activeElement)
    expect(screen.getByText(message.message)).toBeDefined()
    expect(screen.queryByText('We will be in touch.', { exact: true })).toBeNull()
    expect(api.to(`POST ${endpoint}/route`)).toMatchObject([
      {
        path: `${endpoint}/route`,
        body: {
          versionId: form.versionId,
          answers: { [name]: privateAnswer, [email]: 'invitee@example.invalid', [choice]: chosen },
        },
      },
    ])
    expect(screen.getByTestId('location').textContent).toBe(path)
    expect(window.location.href).toBe(url)
    expect(JSON.stringify(storage.mock.calls)).not.toContain(privateAnswer)
    for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain(privateAnswer)
    expect(goTo).not.toHaveBeenCalled()
  })

  it('reviews the new version, retaining only answers compatible by question and option ID', async () => {
    const user = userEvent.setup()
    const revised: Schemas['PublicRoutingForm'] = {
      title: 'Updated meeting form',
      versionId: id(21),
      questions: [
        {
          id: choice,
          type: 'select',
          label: 'Team',
          required: false,
          options: [{ id: chosen, label: 'Sales team' }],
        },
        { id: name, type: 'short_text', label: 'Business', required: true },
        {
          id: removedChoice,
          type: 'select',
          label: 'Updated category',
          required: false,
          options: [{ id: another, label: 'Support' }],
        },
        { id: changedType, type: 'email', label: 'Contact email', required: false },
        { id: newQuestion, type: 'short_text', label: 'New required question', required: true },
      ],
    }
    const metadata = vi
      .fn()
      .mockImplementationOnce(() =>
        json(200, {
          ...form,
          questions: [
            ...form.questions,
            { id: removedChoice, type: 'select', label: 'Category', required: false, options },
            { id: removedQuestion, type: 'short_text', label: 'Old question', required: false },
            { id: changedType, type: 'short_text', label: 'Contact name', required: false },
          ],
        }),
      )
      .mockImplementationOnce(() => json(503, { message: 'diagnostic detail' }))
      .mockImplementationOnce(() => json(200, revised))
    const submission = vi
      .fn()
      .mockImplementationOnce(() => json(409, { error: 'routing_form_changed' }))
      .mockImplementationOnce(() => json(200, message))
    const api = fakeApi({
      ...enabled,
      [`GET ${endpoint}`]: metadata,
      [`POST ${endpoint}/route`]: submission,
    })
    renderApp(path)
    await user.type(await screen.findByLabelText('Company'), 'Acme')
    await user.type(screen.getByLabelText('Work email'), 'invitee@example.invalid')
    await user.selectOptions(screen.getByLabelText('Department'), 'Sales')
    await user.selectOptions(screen.getByLabelText('Category'), 'Sales')
    await user.type(screen.getByLabelText('Old question'), 'Removed')
    await user.type(screen.getByLabelText('Contact name'), 'Changed')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(
      await screen.findByRole('heading', { name: 'We couldn’t load this form. Try again.' }),
    ).toBe(document.activeElement)
    expect(screen.queryByText('diagnostic detail')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(
      await screen.findByRole('heading', {
        name: revised.title,
        description: 'This form has changed. Review your answers before continuing.',
      }),
    ).toBe(document.activeElement)
    expect(
      screen
        .getByText('This form has changed. Review your answers before continuing.')
        .getAttribute('role'),
    ).toBe('status')
    expect((screen.getByLabelText('Business') as HTMLInputElement | HTMLSelectElement).value).toBe(
      'Acme',
    )
    expect((screen.getByLabelText('Team') as HTMLInputElement | HTMLSelectElement).value).toBe(
      chosen,
    )
    expect(
      (screen.getByLabelText('Updated category') as HTMLInputElement | HTMLSelectElement).value,
    ).toBe('')
    expect(
      (screen.getByLabelText('Contact email') as HTMLInputElement | HTMLSelectElement).value,
    ).toBe('')
    expect(screen.queryByLabelText('Work email')).toBeNull()
    expect(screen.queryByLabelText('Old question')).toBeNull()
    expect(submission).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    const added = screen.getByLabelText('New required question')
    expect(document.activeElement).toBe(added)
    expect(submission).toHaveBeenCalledTimes(1)
    await user.type(added, 'Fresh answer')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Thank you' })
    expect(api.to(`POST ${endpoint}/route`)[1]?.body).toEqual({
      versionId: revised.versionId,
      answers: { [name]: 'Acme', [choice]: chosen, [newQuestion]: 'Fresh answer' },
    })
  })

  it('uses the team endpoint and passes the returned continuation URL to browser navigation', async () => {
    vi.mocked(goTo).mockClear()
    const endpoint = '/api/v1/public/-/routing/teams/advisory/intro'
    const continuationUrl = `${window.location.origin}/route/continue#token=server%2Dbuilt%2Dfixture`
    const api = fakeApi({
      ...enabled,
      [`GET ${endpoint}`]: () => json(200, { ...form, questions: [] }),
      [`POST ${endpoint}/route`]: () =>
        json(200, {
          kind: 'continuation',
          continuationUrl,
          routeToken: 'server-built-fixture',
          expiresAt: '2027-04-01T12:00:00Z',
        }),
    })
    renderApp('/route/team/advisory/intro')
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(goTo).toHaveBeenCalledExactlyOnceWith(continuationUrl))
    expect(api.to(`POST ${endpoint}/route`)[0]?.body).toEqual({
      versionId: form.versionId,
      answers: {},
    })
  })

  it('keeps an in-flight submission single and ignores a result after the invitee leaves', async () => {
    vi.mocked(goTo).mockClear()
    const pending = later()
    const api = fakeApi({
      ...enabled,
      [`GET ${endpoint}`]: () => json(200, { ...form, questions: [] }),
      [`POST ${endpoint}/route`]: () => pending.response,
    })
    const page = renderApp(path)
    const button = await screen.findByRole('button', { name: 'Continue' })
    const user = userEvent.setup()
    await user.click(button)
    expect((await screen.findByText('Submitting…')).getAttribute('role')).toBe('status')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    await user.click(button)
    expect(api.to(`POST ${endpoint}/route`)).toHaveLength(1)
    page.unmount()
    await pending.answer(
      json(200, { kind: 'continuation', continuationUrl: '/route/continue#token=late' }),
    )
    expect(goTo).not.toHaveBeenCalled()
  })

  it('clears the form and shows the same neutral unavailable view after publication is withdrawn', async () => {
    fakeApi({
      ...enabled,
      [`GET ${endpoint}`]: () => json(200, { ...form, questions: [] }),
      [`POST ${endpoint}/route`]: () =>
        json(409, { error: 'routing_unavailable', message: 'target diagnostic' }),
    })
    renderApp(path)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('heading', { name: 'This form is unavailable' })).toBe(
      document.activeElement,
    )
    expect(screen.queryByRole('form')).toBeNull()
    expect(screen.queryByText('target diagnostic')).toBeNull()
  })

  it.each(interfaceLanguages('public'))(
    'uses the %s catalogue for stale recovery and unavailable forms',
    async (language) => {
      localStorage.setItem('hourmere-language', language)
      const catalogue = commonCatalogues[`./catalogues/${language}/common.ts`]
      if (!catalogue) throw new Error(`Missing public catalogue for ${language}`)
      const stale = 'This form has changed. Review your answers before continuing.'
      const unavailable = 'This form is unavailable'
      expect(catalogue[stale]).toBeTruthy()
      expect(catalogue[unavailable]).toBeTruthy()
      if (language !== 'en') {
        expect(catalogue[stale]).not.toBe(stale)
        expect(catalogue[unavailable]).not.toBe(unavailable)
      }
      const metadata = vi
        .fn()
        .mockImplementationOnce(() => json(200, { ...form, questions: [] }))
        .mockImplementationOnce(() => json(200, { ...form, questions: [], versionId: id(22) }))
      const submission = vi
        .fn()
        .mockImplementationOnce(() => json(409, { error: 'routing_form_changed' }))
        .mockImplementationOnce(() => json(404, { error: 'routing_form_not_found' }))
      fakeApi({ ...enabled, [`GET ${endpoint}`]: metadata, [`POST ${endpoint}/route`]: submission })
      renderApp(path)
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: catalogue.Continue }))
      expect((await screen.findByText(catalogue[stale] as string)).getAttribute('role')).toBe(
        'status',
      )
      await user.click(screen.getByRole('button', { name: catalogue.Continue }))
      expect(await screen.findByRole('heading', { name: catalogue[unavailable] })).toBe(
        document.activeElement,
      )
      expect(document.documentElement.lang).toBe(language)
    },
  )
})
