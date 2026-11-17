import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { EventType } from '../../api/resources.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import { fakeApi, json, ME, profile, renderApp, signedInAs } from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType, schedule } from '../../test/fixtures.ts'

const patchRoute = `PATCH /api/v1/event-types/${EVENT_TYPE_ID}`
function setup(initial = eventType()) {
  let saved = initial
  const api = fakeApi({
    ...signedInAs(ME),
    ...profile(),
    'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, saved),
    'POST /api/v1/event-types': ({ body }) => {
      saved = eventType(body as Partial<EventType>)
      return json(201, saved)
    },
    [patchRoute]: ({ body }) => {
      saved = { ...saved, ...(body as Partial<EventType>) }
      return json(200, saved)
    },
  })
  return {
    api,
    current: () => saved,
    concurrent: (change: Partial<EventType>) => {
      saved = { ...saved, ...change }
    },
  }
}

const copy = {
  en: {
    title: 'Title',
    save: 'Save changes',
    create: 'Create event type',
    custom: 'Custom duration',
    duration: 'Duration (minutes)',
    preset: (value: number) => `${value} minutes`,
  },
  'zh-CN': {
    title: '标题',
    save: '保存更改',
    create: '创建活动类型',
    custom: '自定义时长',
    duration: '时长（分钟）',
    preset: (value: number) => `${value} 分钟`,
  },
}

describe.each(['en', 'zh-CN'] as const)('default duration shortcuts in %s', (language) => {
  describe.each(['create', 'editor'] as const)('%s', (mode) => {
    it.each([15, 30, 45, 60])(
      'chooses %i minutes with a keyboard-operable named button',
      async (minutes) => {
        chooseLanguage(language)
        const text = copy[language]
        const { api } = setup(eventType({ durationMinutes: 90, allowedDurationsMinutes: [90] }))
        const user = userEvent.setup()
        renderApp(mode === 'create' ? '/app/event-types/new' : `/app/event-types/${EVENT_TYPE_ID}`)
        const title = await screen.findByLabelText(text.title, { exact: true })
        if (mode === 'create') fireEvent.change(title, { target: { value: 'Intro' } })
        const button = screen.getByRole('button', { name: text.preset(minutes) })
        button.focus()
        await user.keyboard('{Enter}')
        expect((screen.getByLabelText(text.duration) as HTMLInputElement).value).toBe(
          String(minutes),
        )
        expect(api.to(mode === 'create' ? 'POST /api/v1/event-types' : patchRoute)).toHaveLength(0)
        await user.click(
          screen.getByRole('button', { name: mode === 'create' ? text.create : text.save }),
        )
        await waitFor(() =>
          expect(api.to(mode === 'create' ? 'POST /api/v1/event-types' : patchRoute)).toHaveLength(
            1,
          ),
        )
        expect(
          api.to(mode === 'create' ? 'POST /api/v1/event-types' : patchRoute)[0]?.body,
        ).toHaveProperty('durationMinutes', minutes)
      },
    )

    it('focuses the custom input and persists a custom default', async () => {
      chooseLanguage(language)
      const text = copy[language]
      const { api } = setup()
      const user = userEvent.setup()
      renderApp(mode === 'create' ? '/app/event-types/new' : `/app/event-types/${EVENT_TYPE_ID}`)
      const title = await screen.findByLabelText(text.title, { exact: true })
      if (mode === 'create') fireEvent.change(title, { target: { value: 'Intro' } })
      await user.click(screen.getByRole('button', { name: text.custom }))
      const duration = screen.getByLabelText(text.duration)
      expect(document.activeElement).toBe(duration)
      fireEvent.change(duration, { target: { value: '75' } })
      await user.click(
        screen.getByRole('button', { name: mode === 'create' ? text.create : text.save }),
      )
      const route = mode === 'create' ? 'POST /api/v1/event-types' : patchRoute
      await waitFor(() => expect(api.to(route)).toHaveLength(1))
      expect(api.to(route)[0]?.body).toHaveProperty('durationMinutes', 75)
    })
  })
})

it('sets a preset default without discarding multiple offered lengths', async () => {
  chooseLanguage('en')
  const { api } = setup(eventType({ allowedDurationsMinutes: [15, 30, 90] }))
  const user = userEvent.setup()
  renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
  await screen.findByLabelText('Title', { exact: true })
  await user.click(screen.getByRole('button', { name: '45 minutes' }))
  expect(screen.getByRole('list', { name: 'Offered lengths' }).textContent).toContain('1 h 30 min')
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(api.to(patchRoute)).toHaveLength(1))
  expect(api.to(patchRoute)[0]?.body).toMatchObject({
    durationMinutes: 45,
    allowedDurationsMinutes: [15, 30, 45, 90],
  })
})

it('keeps unit-only changes pristine and preserves concurrent timing changes during a title save', async () => {
  chooseLanguage('en')
  const { api, concurrent, current } = setup(
    eventType({
      minimumNoticeMinutes: 1440,
      bufferBeforeMinutes: 90,
      bufferAfterMinutes: 60,
      bookingWindowDays: 30,
    }),
  )
  const user = userEvent.setup()
  const view = renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
  const title = await screen.findByLabelText('Title', { exact: true })
  for (const details of view.container.querySelectorAll('details')) details.open = true
  for (const id of [
    'minimumNoticeMinutes',
    'bufferBeforeMinutes',
    'bufferAfterMinutes',
    'bookingWindowDays',
  ]) {
    const field = document.getElementById(id) as HTMLInputElement
    const selector = field.closest('.field')?.querySelector('select') as HTMLSelectElement
    expect(selector.getAttribute('aria-label')).toMatch(/unit$/)
    for (const unit of ['minutes', 'hours', 'days']) await user.selectOptions(selector, unit)
  }
  expect(screen.queryByText('Unsaved changes')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  expect(api.to(patchRoute)).toHaveLength(0)
  const remote = {
    durationMinutes: 45,
    allowedDurationsMinutes: [45],
    minimumNoticeMinutes: 123,
    bufferBeforeMinutes: 17,
    bufferAfterMinutes: 29,
    bookingWindowDays: 91,
  }
  concurrent(remote)
  fireEvent.change(title, { target: { value: 'Renamed' } })
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(api.to(patchRoute)).toHaveLength(1))
  for (const field of Object.keys(remote))
    expect(api.to(patchRoute)[0]?.body).not.toHaveProperty(field)
  expect(current()).toMatchObject({ ...remote, title: 'Renamed' })
})

it('opens custom additional lengths and keeps preset capacity bounded at twelve', async () => {
  chooseLanguage('en')
  const lengths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 30, 60]
  const { api } = setup(eventType({ allowedDurationsMinutes: lengths }))
  const user = userEvent.setup()
  renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
  await screen.findByLabelText('Title', { exact: true })
  const custom = screen.getByLabelText('Duration to add (minutes)')
  const disclosure = custom.closest('details') as HTMLDetailsElement
  disclosure.open = false
  await user.click(screen.getByRole('button', { name: 'Custom duration' }))
  expect(disclosure.open).toBe(true)
  expect(document.activeElement).toBe(custom)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '15 minutes' }).disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '45 minutes' }).disabled).toBe(true)
  const existing = screen.getByRole<HTMLButtonElement>('button', { name: '60 minutes' })
  expect(existing.disabled).toBe(false)
  await user.click(existing)
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(api.to(patchRoute)).toHaveLength(1))
  expect(api.to(patchRoute)[0]?.body).toHaveProperty('durationMinutes', 60)
  expect(api.to(patchRoute)[0]?.body).not.toHaveProperty('allowedDurationsMinutes')
})

it.each(['create', 'editor'] as const)(
  'serializes converted time inputs in original REST units on %s',
  async (mode) => {
    chooseLanguage('en')
    const { api } = setup()
    const user = userEvent.setup()
    const view = renderApp(
      mode === 'create' ? '/app/event-types/new' : `/app/event-types/${EVENT_TYPE_ID}`,
    )
    const title = await screen.findByLabelText('Title', { exact: true })
    if (mode === 'create') fireEvent.change(title, { target: { value: 'Consultation' } })
    for (const details of view.container.querySelectorAll('details')) details.open = true
    for (const [id, unit, value] of [
      ['minimumNoticeMinutes', 'days', '1.5'],
      ['bufferBeforeMinutes', 'hours', '0.5'],
      ['bufferAfterMinutes', 'minutes', '17'],
      ['bookingWindowDays', 'hours', '48'],
    ]) {
      const input = document.getElementById(id as string) as HTMLInputElement
      const selector = input.closest('.field')?.querySelector('select') as HTMLSelectElement
      await user.selectOptions(selector, unit as string)
      fireEvent.change(input, { target: { value } })
    }
    await user.click(
      screen.getByRole('button', {
        name: mode === 'create' ? 'Create event type' : 'Save changes',
      }),
    )
    const route = mode === 'create' ? 'POST /api/v1/event-types' : patchRoute
    await waitFor(() => expect(api.to(route)).toHaveLength(1))
    expect(api.to(route)[0]?.body).toMatchObject({
      minimumNoticeMinutes: 2160,
      bufferBeforeMinutes: 30,
      bufferAfterMinutes: 17,
      bookingWindowDays: 2,
    })
  },
)

describe.each(['en', 'zh-CN'] as const)('editor feedback in %s', (language) => {
  it('confirms an untouched save without writing and clears stale timing errors after correction', async () => {
    chooseLanguage(language)
    const { api } = setup()
    const user = userEvent.setup()
    const view = renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    await screen.findByLabelText(copy[language].title, { exact: true })
    const save = screen.getByRole('button', { name: copy[language].save })
    await user.click(save)
    expect(
      await screen.findByText(language === 'en' ? 'No changes to save.' : '没有需要保存的更改。'),
    ).toBeTruthy()
    expect(api.to(patchRoute)).toHaveLength(0)
    for (const details of view.container.querySelectorAll('details')) details.open = true
    const input = document.getElementById('minimumNoticeMinutes') as HTMLInputElement
    const selector = input.closest('.field')?.querySelector('select') as HTMLSelectElement
    fireEvent.change(input, { target: { value: 'invalid text' } })
    await user.click(save)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    await user.selectOptions(selector, 'days')
    expect(input.value).toBe('invalid text')
    expect(api.to(patchRoute)).toHaveLength(0)
    fireEvent.change(input, { target: { value: '2' } })
    await user.selectOptions(selector, 'hours')
    expect(input.value).toBe('48')
    expect(input.getAttribute('aria-invalid')).toBeNull()
    expect(document.getElementById('minimumNoticeMinutes-error')).toBeNull()
    const hint = document.getElementById('bookingWindowDays-hint')?.textContent
    expect(hint).toContain(
      language === 'en'
        ? 'How far into the future invitees can book, in calendar days.'
        : '受邀人可以提前多少个日历日预约。',
    )
    expect(hint).not.toContain('。 ')
    await user.click(save)
    await waitFor(() => expect(api.to(patchRoute)).toHaveLength(1))
    expect(api.to(patchRoute)[0]?.body).toHaveProperty('minimumNoticeMinutes', 2880)
  })

  it('explains why new preset lengths are disabled at capacity', async () => {
    chooseLanguage(language)
    setup(eventType({ allowedDurationsMinutes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 30, 60] }))
    const view = renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    await screen.findByLabelText(copy[language].title, { exact: true })
    for (const details of view.container.querySelectorAll('details')) details.open = true
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: copy[language].preset(15) }).disabled,
    ).toBe(true)
    expect(
      screen.getByText(
        language === 'en'
          ? 'All 12 lengths are in use. Remove a length in Additional durations before adding another.'
          : '已使用全部 12 个时长。请先在「更多时长」中移除一个时长，再添加新时长。',
      ),
    ).toBeTruthy()
    expect(
      screen.getByText(
        language === 'en'
          ? 'All 12 lengths are in use. Remove a length before adding another.'
          : '已使用全部 12 个时长。请先移除一个时长，再添加新时长。',
      ),
    ).toBeTruthy()
  })
})
