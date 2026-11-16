import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import type { EventType } from '../../api/resources.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import { fakeApi, json, ME, profile, renderApp, signedInAs } from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType, schedule } from '../../test/fixtures.ts'
import { DurationsEditor } from './DurationsEditor.tsx'

const words = {
  en: {
    title: 'Title',
    default: 'Default duration',
    primaryDuration: 'Duration (minutes)',
    durationsGroup: 'Additional durations',
    addInput: 'Duration to add (minutes)',
    add: 'Add duration',
    preset: 'Add 45 min',
    remove: 'Remove 30 min',
    list: 'Offered lengths',
    create: 'Create event type',
    save: 'Save changes',
    saved: 'Saved.',
    share: 'View and share',
    duplicate: 'This duration is already in the list.',
    range: 'Enter a number from 1 to 1,440.',
    whole: 'Enter a whole number.',
    count: 'Offer from 1 to 12 durations.',
    hint: 'Offer 1–12 different lengths, from 1 to 1,440 minutes. Invitees choose a length before a time.',
  },
  'zh-CN': {
    title: '标题',
    default: '默认时长',
    primaryDuration: '时长（分钟）',
    durationsGroup: '更多时长',
    addInput: '要添加的时长（分钟）',
    add: '添加时长',
    preset: '添加 45 分钟',
    remove: '移除 30 分钟',
    list: '已提供的时长',
    create: '创建活动类型',
    save: '保存更改',
    saved: '已保存。',
    share: '查看与分享',
    duplicate: '此时长已在列表中。',
    range: '请输入 1 至 1,440 之间的数字。',
    whole: '请输入整数。',
    count: '请提供 1–12 种时长。',
    hint: '提供 1–12 种不同时长，每种为 1–1440 分钟。受邀人先选择时长，再选择时间。',
  },
}

function Harness({ initial = [30] }: { initial?: number[] }) {
  const [durations, setDurations] = useState(initial)
  const [duration, setDuration] = useState(String(initial[0]))
  return (
    <DurationsEditor
      durations={durations}
      defaultDuration={duration}
      errors={{}}
      onDefaultChange={setDuration}
      onChange={(values, selected) => {
        setDurations(values)
        setDuration(selected)
      }}
    />
  )
}

describe.each(['en', 'zh-CN'] as const)('allowed durations editor in %s', (language) => {
  it.each(['personal', 'individual', 'collective', 'round_robin'] as const)(
    'round trips multiple lengths and the default in a %s event',
    async (mode) => {
      chooseLanguage(language)
      const copy = words[language]
      const personal = mode === 'personal'
      const me = {
        ...ME,
        organization: { ...ME.organization, personal },
      }
      const peer = '00000000-0000-7000-8000-000000000004'
      const notifications: EventType['notifications'] = {
        reminders: [],
        followUps: [
          {
            id: 'thanks',
            offsetMinutes: 60,
            recipients: { invitee: true, host: false, guests: false },
            hostNote: 'Thanks for meeting.',
          },
        ],
      }
      let saved = eventType({
        ownerUserId: personal ? ME.user.id : null,
        schedulingType: mode === 'personal' ? 'individual' : mode,
        hosts:
          mode === 'collective'
            ? [{ userId: ME.user.id }, { userId: peer }]
            : [{ userId: ME.user.id }],
        allowedDurationsMinutes: [15, 30, 60],
        notifications,
      })
      const api = fakeApi({
        ...signedInAs(me),
        ...profile(),
        'GET /api/auth/organization/get-active-member': () =>
          json(200, { organizationId: me.organization.id, userId: me.user.id, role: 'admin' }),
        'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
        'GET /api/v1/event-type-hosts': () =>
          json(200, {
            data: [
              { id: ME.user.id, name: 'Ada' },
              { id: peer, name: 'Peer' },
            ],
            nextAfter: null,
          }),
        [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, saved),
        [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: ({ body }) => {
          saved = { ...saved, ...(body as Partial<EventType>) }
          return json(200, saved)
        },
      })
      const user = userEvent.setup()
      const view = renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      const select = await screen.findByLabelText<HTMLSelectElement>(copy.primaryDuration)
      expect(select.value).toBe('30')
      expect([...select.options].map(({ value }) => value)).toEqual(['15', '30', '60'])
      await user.click(screen.getByRole('button', { name: copy.preset }))
      await user.selectOptions(select, '45')
      await user.click(screen.getByRole('button', { name: copy.remove }))
      const custom = screen.getByLabelText(copy.addInput)
      await user.type(custom, '75{Enter}')
      expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)).toHaveLength(0)
      expect([...select.options].map(({ value }) => value)).toEqual(['15', '45', '60', '75'])
      await user.click(screen.getByRole('button', { name: copy.save }))
      await screen.findByText(copy.saved)
      expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body).toMatchObject({
        allowedDurationsMinutes: [15, 45, 60, 75],
        durationMinutes: 45,
      })
      expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body).not.toHaveProperty(
        'notifications',
      )
      expect(saved.notifications).toEqual(notifications)
      expect(screen.getByRole('region', { name: copy.share })).toBeDefined()
      view.unmount()
      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      const reloaded = await screen.findByLabelText<HTMLSelectElement>(copy.primaryDuration)
      expect(reloaded.value).toBe('45')
      expect([...reloaded.options].map(({ value }) => value)).toEqual(['15', '45', '60', '75'])
    },
  )

  it('creates with a chosen length and keeps the saved share panel', async () => {
    chooseLanguage(language)
    const copy = words[language]
    let saved = eventType()
    const api = fakeApi({
      ...signedInAs(ME),
      ...profile(),
      'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
      'POST /api/v1/event-types': ({ body }) => {
        saved = eventType(body as Partial<EventType>)
        return json(201, saved)
      },
      [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, saved),
    })
    const user = userEvent.setup()
    renderApp('/app/event-types/new')
    await user.type(await screen.findByLabelText(copy.title, { exact: true }), 'Intro')
    await user.click(screen.getByText(copy.durationsGroup, { selector: 'summary' }))
    await user.click(screen.getByRole('button', { name: copy.preset }))
    await user.selectOptions(screen.getByLabelText(copy.primaryDuration), '45')
    await user.click(screen.getByRole('button', { name: copy.create }))
    expect(await screen.findByRole('region', { name: copy.share })).toBeDefined()
    expect(api.to('POST /api/v1/event-types')[0]?.body).toMatchObject({
      allowedDurationsMinutes: [30, 45],
      durationMinutes: 45,
    })
  })

  it.each([{ initial: [30] }, { initial: [15, 30, 60] }])(
    'preserves a concurrently changed offered list when editing only the title (baseline $initial)',
    async ({ initial }) => {
      chooseLanguage(language)
      const copy = words[language]
      let saved = eventType({ allowedDurationsMinutes: initial })
      const api = fakeApi({
        ...signedInAs(ME),
        ...profile(),
        'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
        [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, saved),
        [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: ({ body }) => {
          saved = { ...saved, ...(body as Partial<EventType>) }
          return json(200, saved)
        },
      })
      const user = userEvent.setup()
      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      const title = await screen.findByLabelText(copy.title, { exact: true })
      // A separate REST/MCP/CLI client adds a length while this editor remains open.
      saved = { ...saved, allowedDurationsMinutes: [15, 30, 60, 90] }
      await user.clear(title)
      await user.type(title, 'Renamed')
      await user.click(screen.getByRole('button', { name: copy.save }))
      await screen.findByText(copy.saved)
      expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body).not.toHaveProperty(
        'allowedDurationsMinutes',
      )
      expect(saved.allowedDurationsMinutes).toEqual([15, 30, 60, 90])
    },
  )

  it('rejects duplicate, fractional and out-of-range custom lengths beside the input', async () => {
    chooseLanguage(language)
    const copy = words[language]
    render(<Harness />)
    const user = userEvent.setup()
    const input = screen.getByLabelText(copy.addInput)
    expect(screen.getByText(copy.hint)).toBeDefined()
    for (const [value, message] of [
      ['30', copy.duplicate],
      ['0', copy.range],
      ['1441', copy.range],
      ['1.5', copy.whole],
    ] as const) {
      await user.clear(input)
      await user.type(input, value)
      await user.click(screen.getByRole('button', { name: copy.add }))
      expect(document.getElementById('duration-to-add-error')?.textContent).toContain(message)
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect(input.getAttribute('aria-describedby')).toContain('duration-to-add-error')
      expect(document.activeElement).toBe(input)
      expect(
        within(screen.getByRole('list', { name: copy.list })).getAllByRole('listitem'),
      ).toHaveLength(1)
    }
  })

  it('announces failed Enter additions without moving focus, including repeated duplicates', async () => {
    chooseLanguage(language)
    const copy = words[language]
    render(<Harness />)
    const user = userEvent.setup()
    const input = screen.getByLabelText(copy.addInput)
    const status = screen.getByRole('status')
    for (const [value, message] of [
      ['30', copy.duplicate],
      ['0', copy.range],
      ['1.5', copy.whole],
    ] as const) {
      await user.clear(input)
      await user.type(input, `${value}{Enter}`)
      await waitFor(() => expect(status.textContent).toBe(message))
      expect(document.activeElement).toBe(input)
    }
    await user.clear(input)
    await user.type(input, '30{Enter}')
    await waitFor(() => expect(status.textContent).toBe(copy.duplicate))
    const announcements: (string | null)[] = []
    const observer = new MutationObserver(() => announcements.push(status.textContent))
    observer.observe(status, { childList: true, characterData: true, subtree: true })
    try {
      await user.keyboard('{Enter}')
      await waitFor(() => expect(announcements).toContain(copy.duplicate))
      expect(announcements).toContain('')
      expect(document.activeElement).toBe(input)
      expect((input as HTMLInputElement).value).toBe('30')
    } finally {
      observer.disconnect()
    }
  })

  it('accepts both bounds and blocks a thirteenth distinct length', async () => {
    chooseLanguage(language)
    const copy = words[language]
    render(<Harness initial={[15, 30, 45, 60, 90, 120, 180, 240, 360, 720]} />)
    const user = userEvent.setup()
    const input = screen.getByLabelText(copy.addInput)
    await user.type(input, '1{Enter}')
    await user.type(input, '1440{Enter}')
    await user.type(input, '25{Enter}')
    expect(document.getElementById('duration-to-add-error')?.textContent).toContain(copy.count)
    const select = screen.getByLabelText<HTMLSelectElement>(copy.default)
    expect([...select.options].map(({ value }) => Number(value))).toEqual([
      1, 15, 30, 45, 60, 90, 120, 180, 240, 360, 720, 1440,
    ])
    expect(input.getAttribute('aria-invalid')).toBe('true')
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(copy.count))
    expect(document.activeElement).toBe(input)
  })

  it('keeps focus and a valid default when removing the default, and retains one length', async () => {
    chooseLanguage(language)
    const copy = words[language]
    render(<Harness initial={[30, 45]} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: copy.remove }))
    const select = screen.getByLabelText<HTMLSelectElement>(copy.default)
    expect(select.value).toBe('45')
    expect([...select.options].map(({ value }) => value)).toEqual(['45'])
    expect(document.activeElement).toBe(select)
    const remove = within(
      screen.getByRole('list', { name: copy.list }),
    ).getByRole<HTMLButtonElement>('button')
    expect(remove.disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toMatch(/45/)
    await user.click(remove)
    expect(select.options).toHaveLength(1)
  })
})
