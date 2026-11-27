import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventType } from '../../api/resources.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import { resolveEventTypeEditor } from '../../test/event-type-editor.ts'
import { fakeApi, json, ME, profile, renderApp, signedInAs } from '../../test/fake-api.tsx'
import { eventType, schedule } from '../../test/fixtures.ts'

beforeAll(resolveEventTypeEditor)

const createdId = 'e0000000-0000-7000-8000-000000000010'
const copyId = 'e0000000-0000-7000-8000-000000000011'
const words = {
  en: {
    title: 'Title',
    create: 'Create event type',
    save: 'Save changes',
    saved: 'Saved.',
    back: 'Back to event types',
    duplicate: 'Duplicate',
    remove: 'Delete',
    confirm: 'Delete event type',
    cancel: 'Cancel',
    more: (title: string) => `More actions for ${title}`,
    enable: (title: string) => `Enable ${title}`,
  },
  'zh-CN': {
    title: '标题',
    create: '创建活动类型',
    save: '保存更改',
    saved: '已保存。',
    back: '返回活动类型',
    duplicate: '复制',
    remove: '删除',
    confirm: '删除活动类型',
    cancel: '取消',
    more: (title: string) => `${title} 的更多操作`,
    enable: (title: string) => `启用 ${title}`,
  },
} as const

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    }),
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    }),
  })
})

// Match the viewport/media-query stubs used by BookingPanel tests. jsdom checks
// interaction at both viewport settings; the Playwright projects check real geometry.
function viewport(width: number) {
  vi.stubGlobal('innerWidth', width)
  vi.stubGlobal('innerHeight', 900)
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('max-width') ? width <= 767 : width >= 768,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
}

for (const account of ['empty', 'existing'] as const) {
  for (const language of ['en', 'zh-CN'] as const) {
    describe.each([320, 1280])(`${account} account, ${language}, %ipx`, (width) => {
      it('creates essentials, saves timing in every unit, duplicates, toggles and confirms deletion', async () => {
        viewport(width)
        chooseLanguage(language)
        const text = words[language]
        const existing = account === 'existing'
        const originals = existing
          ? [
              eventType(),
              eventType({
                id: 'e0000000-0000-7000-8000-000000000002',
                title: 'Follow-up',
                slug: 'follow-up',
              }),
              eventType({
                id: 'e0000000-0000-7000-8000-000000000003',
                title: 'Workshop',
                slug: 'workshop',
                isActive: false,
              }),
            ]
          : []
        const records = new Map(originals.map((event) => [event.id, event]))
        const api = fakeApi({
          ...signedInAs(ME),
          ...(existing ? profile() : profile(null)),
          'GET /api/v1/schedules': () => json(200, { data: existing ? [schedule()] : [] }),
          'GET /api/v1/calendar-connections': () =>
            json(200, {
              data: existing
                ? [{ provider: 'google', status: 'active', syncAuthorized: true }]
                : [],
            }),
          'GET /api/v1/conference-connections': () =>
            json(200, {
              data: existing ? [{ provider: 'zoom', mode: 'meetings', status: 'active' }] : [],
            }),
          'GET /api/v1/event-types': () => json(200, { data: [...records.values()] }),
          'POST /api/v1/event-types': ({ body }) => {
            const created = eventType({ ...(body as Partial<EventType>), id: createdId })
            records.set(createdId, created)
            return json(201, created)
          },
          ...Object.fromEntries(
            [createdId, copyId].flatMap((id) => [
              [`GET /api/v1/event-types/${id}`, () => json(200, records.get(id))],
              [
                `PATCH /api/v1/event-types/${id}`,
                ({ body }: { body: unknown }) => {
                  const updated = {
                    ...records.get(id),
                    ...(body as Partial<EventType>),
                  } as EventType
                  records.set(id, updated)
                  return json(200, updated)
                },
              ],
            ]),
          ),
          [`POST /api/v1/event-types/${createdId}/duplicate`]: () => {
            const copied = {
              ...records.get(createdId),
              id: copyId,
              title: 'Acceptance copy',
              slug: 'acceptance-copy',
            } as EventType
            records.set(copyId, copied)
            return json(201, copied)
          },
          [`DELETE /api/v1/event-types/${copyId}`]: () => {
            records.delete(copyId)
            return new Response(null, { status: 204 })
          },
        })
        const user = userEvent.setup()
        const view = renderApp('/app/event-types/new')
        await user.type(await screen.findByLabelText(text.title, { exact: true }), 'Acceptance')
        expect([...view.container.querySelectorAll('details')].every((group) => !group.open)).toBe(
          true,
        )
        expect(
          [...view.container.querySelectorAll('form input, form select, form textarea')]
            .filter((control) => !control.closest('details'))
            .map((control) => control.id),
        ).toEqual(['title', 'slug', 'durationMinutes', 'location-kind'])
        expect((document.getElementById('location-kind') as HTMLSelectElement).value).toBe(
          existing ? 'google_meet' : '',
        )
        await user.click(screen.getByRole('button', { name: text.create }))
        await waitFor(() =>
          expect(screen.getByTestId('location').textContent).toBe(`/app/event-types/${createdId}`),
        )
        expect(api.to('POST /api/v1/event-types')[0]?.body).toMatchObject({
          title: 'Acceptance',
          slug: 'acceptance',
          durationMinutes: 30,
          scheduleId: null,
          location: existing ? { kind: 'google_meet' } : null,
          minimumNoticeMinutes: 0,
          bookingWindowDays: null,
        })
        await screen.findByLabelText(text.title, { exact: true })
        const timing = document
          .getElementById('minimumNoticeMinutes')
          ?.closest('details') as HTMLDetailsElement
        await user.click(timing.querySelector('summary') as HTMLElement)
        for (const [unit, minutes, days, expectedMinutes, expectedDays] of [
          ['minutes', '90', '2880', 90, 2],
          ['hours', '2', '72', 120, 3],
          ['days', '1', '4', 1440, 4],
        ] as const) {
          for (const field of [
            'minimumNoticeMinutes',
            'bufferBeforeMinutes',
            'bufferAfterMinutes',
            'bookingWindowDays',
          ]) {
            const input = document.getElementById(field) as HTMLInputElement
            const select = input.parentElement?.querySelector('select') as HTMLSelectElement
            await user.selectOptions(select, unit)
            fireEvent.change(input, {
              target: { value: field === 'bookingWindowDays' ? days : minutes },
            })
          }
          const before = api.to(`PATCH /api/v1/event-types/${createdId}`).length
          await user.click(screen.getByRole('button', { name: text.save }))
          await waitFor(() =>
            expect(api.to(`PATCH /api/v1/event-types/${createdId}`)).toHaveLength(before + 1),
          )
          await screen.findByText(text.saved, { exact: true })
          expect(api.to(`PATCH /api/v1/event-types/${createdId}`).at(-1)?.body).toMatchObject({
            minimumNoticeMinutes: expectedMinutes,
            bufferBeforeMinutes: expectedMinutes,
            bufferAfterMinutes: expectedMinutes,
            bookingWindowDays: expectedDays,
          })
        }
        await user.click(screen.getByRole('link', { name: text.back }))
        await user.click(await screen.findByRole('button', { name: text.more('Acceptance') }))
        await user.click(screen.getByRole('menuitem', { name: text.duplicate }))
        await waitFor(() =>
          expect(screen.getByTestId('location').textContent).toBe(`/app/event-types/${copyId}`),
        )
        await user.click(await screen.findByRole('link', { name: text.back }))
        const toggle = await screen.findByRole('switch', { name: text.enable('Acceptance copy') })
        await user.click(toggle)
        await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
        expect(toggle.getAttribute('aria-checked')).toBe('false')
        expect(api.to(`PATCH /api/v1/event-types/${copyId}`)[0]?.body).toEqual({ isActive: false })
        await user.click(screen.getByRole('button', { name: text.more('Acceptance copy') }))
        await user.click(screen.getByRole('menuitem', { name: text.remove }))
        let dialog = screen.getByRole('dialog')
        expect(within(dialog).getByText(/Acceptance copy/, { exact: false })).toBeTruthy()
        expect(api.to(`DELETE /api/v1/event-types/${copyId}`)).toHaveLength(0)
        await user.click(within(dialog).getByRole('button', { name: text.cancel }))
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(api.to(`DELETE /api/v1/event-types/${copyId}`)).toHaveLength(0)
        await user.click(screen.getByRole('button', { name: text.more('Acceptance copy') }))
        await user.click(screen.getByRole('menuitem', { name: text.remove }))
        dialog = screen.getByRole('dialog')
        await user.click(within(dialog).getByRole('button', { name: text.confirm }))
        await waitFor(() =>
          expect(screen.queryByRole('switch', { name: text.enable('Acceptance copy') })).toBeNull(),
        )
        expect(api.to(`DELETE /api/v1/event-types/${copyId}`)).toHaveLength(1)
        expect(records.has(createdId)).toBe(true)
        expect(originals.map((event) => records.get(event.id))).toEqual(originals)
        for (const call of api.calls.filter((call) =>
          ['POST', 'PATCH', 'DELETE'].includes(call.method),
        )) {
          expect(call.headers.get('X-Expected-Organization-Id')).toBe(ME.organization.id)
        }
      })
    })
  }
}
