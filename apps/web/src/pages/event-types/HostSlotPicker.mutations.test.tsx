import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { registeredLocales } from '@hourmere/core/language'
import * as snippet from '@hourmere/core/slot-snippet'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as react from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useI18n } from '../../i18n/runtime.tsx'
import { codeOf, eventSlots, getEventType } from '../../public/api.ts'
import { addDays, parseDateKey } from '../../public/calendar.ts'
import { dateKeyIn, instantOf } from '../../public/time.ts'
import { fakeApi, json, later, PROFILE } from '../../test/fake-api.tsx'
import { eventType } from '../../test/fixtures.ts'
import type { HostSlotPicker, HostSlotPickerProps } from './HostSlotPicker.tsx'

const source = readFileSync('apps/web/src/pages/event-types/HostSlotPicker.tsx', 'utf8')
const production = source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')
const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
afterEach(() => {
  if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

const DAY = dateKeyIn(Date.now(), PROFILE.timeZone)
const START = `${DAY}T09:00:00.000Z`
const END = `${DAY}T09:30:00.000Z`
const META = 'GET /api/v1/public/ada/intro-call'
const ROUTE = 'GET /api/v1/public/ada/intro-call/slots'
const publicEvent = {
  title: 'Intro call',
  handle: 'ada',
  slug: 'intro-call',
  durationMinutes: 30,
  allowedDurationsMinutes: [30, 60],
}
const props = (overrides: Partial<HostSlotPickerProps> = {}): HostSlotPickerProps => ({
  event: eventType({ allowedDurationsMinutes: [30, 60] }),
  profile: PROFILE,
  address: { kind: 'personal', handle: 'ada', slug: 'intro-call' },
  publicUrl: 'https://booking.example.com',
  verifyAccess: vi.fn(async () => {}),
  ...overrides,
})
function component(code: string, overrides: Record<string, unknown> = {}): typeof HostSlotPicker {
  const compiled = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { readFileSync } from 'node:fs'; import { transformSync } from 'esbuild'; process.stdout.write(transformSync(readFileSync(0, 'utf8'), { loader:'tsx',format:'cjs',jsxFactory:'reactRuntime.createElement',jsxFragment:'reactRuntime.Fragment' }).code)",
    ],
    { input: code.replace(/^export /gm, ''), encoding: 'utf8' },
  )
  const deps = {
    useEffect: react.useEffect,
    useId: react.useId,
    useMemo: react.useMemo,
    useRef: react.useRef,
    useState: react.useState,
    ...snippet,
    registeredLocales,
    timeZoneNames: () => ['UTC', 'Europe/Berlin', 'EST5EDT'],
    useI18n,
    eventSlots,
    getEventType,
    codeOf,
    dateKeyIn,
    instantOf,
    addDays,
    parseDateKey,
    ...overrides,
  }
  return new Function('reactRuntime', ...Object.keys(deps), `${compiled}; return HostSlotPicker`)(
    react,
    ...Object.values(deps),
  ) as typeof HostSlotPicker
}
function mutate(before: string, after: string) {
  expect(production.split(before), 'source mutation matches once').toHaveLength(2)
  return production.replace(before, after)
}
async function detects(before: string, after: string, assertion: (code: string) => Promise<void>) {
  await assertion(production)
  await expect(assertion(mutate(before, after))).rejects.toMatchObject({ name: 'AssertionError' })
  await assertion(production)
}
const available = () => within(screen.getByRole('group', { name: 'Available times' }))
async function choose(indices = [0]) {
  await waitFor(() => expect(available().queryAllByRole('checkbox').length).toBeGreaterThan(0))
  for (const index of indices)
    fireEvent.click(available().getAllByRole('checkbox')[index] as HTMLInputElement)
}
async function preview() {
  fireEvent.click(screen.getByRole('button', { name: 'Preview email' }))
  await screen.findByRole('textbox', { name: 'Complete plain-text email preview' })
}
function clipboard() {
  const writeText = vi.fn(async (_value: string) => {})
  const write = vi.fn(async (_items: unknown[]) => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText, write } })
  return { writeText, write }
}
class PromiseItem {
  readonly data: Record<string, Blob | Promise<Blob>>
  constructor(data: Record<string, Blob | Promise<Blob>>) {
    this.data = data
  }
  get types() {
    return Object.keys(this.data)
  }
  async getType(type: string) {
    return await this.data[type]
  }
}
function promiseClipboard() {
  const clip = clipboard()
  vi.stubGlobal('ClipboardItem', PromiseItem)
  clip.write.mockImplementation(async (items) => {
    for (const item of items as PromiseItem[])
      await Promise.all(item.types.map((type) => item.getType(type)))
  })
  return clip
}
function server() {
  return fakeApi({
    [ROUTE]: () => json(200, { data: [{ start: START, end: END }] }),
    [META]: () => json(200, publicEvent),
  })
}

describe('host picker production-source protections', () => {
  it('detects accepting an interval with only its start matching', async () => {
    await detects(' && Date.parse(a.end) === Date.parse(b.end)', '', async (code) => {
      let recheck = false
      fakeApi({
        [META]: () => json(200, publicEvent),
        [ROUTE]: () =>
          json(200, { data: [{ start: START, end: recheck ? `${DAY}T10:00:00.000Z` : END }] }),
      })
      const clip = clipboard()
      const Picker = component(code)
      const view = render(<Picker {...props()} />)
      try {
        await choose()
        await preview()
        recheck = true
        fireEvent.click(screen.getByRole('button', { name: 'Copy plain text' }))
        await waitFor(() => expect(screen.queryByText('Checking selected times…')).toBeNull())
        expect(clip.writeText).not.toHaveBeenCalled()
        expect(screen.queryByText('No longer offered')).not.toBeNull()
      } finally {
        view.unmount()
      }
    })
  })

  it('detects bypassing all-or-nothing validation', async () => {
    await detects('if (unavailable.length) {', 'if (false) {', async (code) => {
      let recheck = false
      fakeApi({
        [META]: () => json(200, publicEvent),
        [ROUTE]: () => json(200, { data: recheck ? [] : [{ start: START, end: END }] }),
      })
      const clip = clipboard()
      const Picker = component(code)
      const view = render(<Picker {...props()} />)
      try {
        await choose()
        await preview()
        recheck = true
        fireEvent.click(screen.getByRole('button', { name: 'Copy plain text' }))
        await waitFor(() => expect(screen.queryByText('Checking selected times…')).toBeNull())
        expect(clip.writeText).not.toHaveBeenCalled()
      } finally {
        view.unmount()
      }
    })
  })

  it('detects silently dropping a stale selection', async () => {
    await detects(
      'setStale(unavailable.map((slot) => slot.start))',
      'setStale(unavailable.map((slot) => slot.start)); setSelected([])',
      async (code) => {
        let recheck = false
        fakeApi({
          [META]: () => json(200, publicEvent),
          [ROUTE]: () => json(200, { data: recheck ? [] : [{ start: START, end: END }] }),
        })
        clipboard()
        const Picker = component(code)
        const view = render(<Picker {...props()} />)
        try {
          await choose()
          await preview()
          recheck = true
          fireEvent.click(screen.getByRole('button', { name: 'Copy plain text' }))
          await screen.findByText(
            'Some selected times are no longer offered. Nothing was copied. Remove those times manually before trying again.',
          )
          expect(screen.queryByText('Selected times: 1 (maximum 10)')).not.toBeNull()
          expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeNull()
        } finally {
          view.unmount()
        }
      },
    )
  })

  it('detects retaining alternatives after changing duration', async () => {
    await detects('setSelected([])', '', async (code) => {
      server()
      const Picker = component(code)
      const view = render(<Picker {...props()} />)
      try {
        await choose()
        await preview()
        fireEvent.change(screen.getByRole('combobox', { name: 'Meeting length' }), {
          target: { value: '60' },
        })
        expect(screen.queryByText('Selected times: 0 (maximum 10)')).not.toBeNull()
      } finally {
        view.unmount()
      }
    })
  })

  it('detects omitting the explicit singleton duration from exact checks', async () => {
    const before = `          const slots = await eventSlots(\n            handle,\n            slug,\n            team,\n            durationMinutes,\n          )(slot.start, end, controller.signal)`
    await detects(before, before.replace('            durationMinutes,\n', ''), async (code) => {
      const client = server()
      const clip = clipboard()
      const Picker = component(code)
      const view = render(<Picker {...props({ event: eventType() })} />)
      try {
        await choose()
        await preview()
        fireEvent.click(screen.getByRole('button', { name: 'Copy plain text' }))
        await waitFor(() => expect(clip.writeText).toHaveBeenCalled())
        const query = new URL(client.to(ROUTE)[1]?.path ?? '', location.origin).searchParams
        expect(query.get('durationMinutes')).toBe('30')
      } finally {
        view.unmount()
      }
    })
  })

  it('detects copying a removed meeting duration', async () => {
    await detects('if (!allowed.includes(durationMinutes)) {', 'if (false) {', async (code) => {
      fakeApi({
        [META]: () =>
          json(200, { ...publicEvent, allowedDurationsMinutes: [60], durationMinutes: 60 }),
        [ROUTE]: () => json(200, { data: [{ start: START, end: END }] }),
      })
      const clip = clipboard()
      const Picker = component(code)
      const view = render(<Picker {...props()} />)
      try {
        await choose()
        await preview()
        fireEvent.click(screen.getByRole('button', { name: 'Copy plain text' }))
        await waitFor(() => expect(screen.queryByText('Checking selected times…')).toBeNull())
        expect(clip.writeText).not.toHaveBeenCalled()
      } finally {
        view.unmount()
      }
    })
  })

  it('detects classifying an unknown check as unavailable', async () => {
    await detects(
      "if (results.some((result) => result.status === 'rejected')) {",
      'if (false) {',
      async (code) => {
        let recheck = false
        fakeApi({
          [META]: () => json(200, publicEvent),
          [ROUTE]: () =>
            recheck
              ? json(403, { error: 'forbidden' })
              : json(200, { data: [{ start: START, end: END }] }),
        })
        const clip = clipboard()
        const Picker = component(code)
        const view = render(<Picker {...props()} />)
        try {
          await choose()
          await preview()
          recheck = true
          fireEvent.click(screen.getByRole('button', { name: 'Copy plain text' }))
          await waitFor(() => expect(screen.queryByText('Checking selected times…')).toBeNull())
          expect(clip.writeText).not.toHaveBeenCalled()
          expect(
            screen.queryByText(
              'We could not check the selected times. Nothing was copied. Please try again.',
            ),
          ).not.toBeNull()
          expect(screen.queryByText('No longer offered')).toBeNull()
        } finally {
          view.unmount()
        }
      },
    )
  })

  it('detects removing the second current-role check', async () => {
    const before =
      "      await verifyAccess()\n      if (!current()) throw new Error('copy_cancelled')\n      const canonicalAddress"
    await detects(before, before.replace('      await verifyAccess()\n', ''), async (code) => {
      server()
      const clip = clipboard()
      const verifyAccess = vi
        .fn(async () => {})
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('removed_manager'))
      const Picker = component(code)
      const view = render(<Picker {...props({ verifyAccess })} />)
      try {
        await choose()
        await preview()
        fireEvent.click(screen.getByRole('button', { name: 'Copy plain text' }))
        await waitFor(() => expect(screen.queryByText('Checking selected times…')).toBeNull())
        expect(clip.writeText).not.toHaveBeenCalled()
        expect(verifyAccess).toHaveBeenCalledTimes(3)
      } finally {
        view.unmount()
      }
    })
  })

  it('detects late copy completion after saved-event navigation', async () => {
    const before =
      '    const current = () =>\n      !controller.signal.aborted && version.current === requestVersion && !blocked.current\n    setBusy(true)\n    setManual(false)'
    await detects(
      before,
      '    const current = () => true\n    setBusy(true)\n    setManual(false)',
      async (code) => {
        const pending = later()
        fakeApi({
          [META]: () => pending.response,
          [ROUTE]: () => json(200, { data: [{ start: START, end: END }] }),
        })
        const clip = clipboard()
        const Picker = component(code)
        const value = props()
        const view = render(<Picker {...value} />)
        try {
          await choose()
          await preview()
          fireEvent.click(screen.getByRole('button', { name: 'Copy plain text' }))
          await screen.findByText('Checking selected times…')
          view.rerender(<Picker {...value} event={eventType({ id: 'changed' })} />)
          await pending.answer(json(200, publicEvent))
          expect(clip.writeText).not.toHaveBeenCalled()
        } finally {
          view.unmount()
        }
      },
    )
  })

  it('detects omission of the hidden-event forwarding warning', async () => {
    await detects('event.isHidden && (', 'false && (', async (code) => {
      server()
      const Picker = component(code)
      const view = render(<Picker {...props({ event: eventType({ isHidden: true }) })} />)
      try {
        expect(
          screen.queryByText(
            'This event type is unlisted. Anyone with these links can open the booking page and book an available time.',
          ),
        ).not.toBeNull()
      } finally {
        view.unmount()
      }
    })
  })

  it('detects a rich clipboard missing its complete plain-text alternative', async () => {
    await detects(
      "kind === 'rich' ? { 'text/plain': plain, 'text/html': html } : { 'text/plain': plain }",
      "kind === 'rich' ? { 'text/html': html } : { 'text/plain': plain }",
      async (code) => {
        server()
        const clip = clipboard()
        class Item {
          data: Record<string, Blob | Promise<Blob>>
          constructor(data: Record<string, Blob | Promise<Blob>>) {
            this.data = data
          }
          getType(type: string) {
            return Promise.resolve(this.data[type] as Blob | Promise<Blob>)
          }
        }
        vi.stubGlobal('ClipboardItem', Item)
        const Picker = component(code)
        const view = render(<Picker {...props()} />)
        try {
          await choose()
          await preview()
          fireEvent.click(screen.getByRole('button', { name: 'Copy rich text' }))
          await waitFor(() => expect(clip.write).toHaveBeenCalled())
          const item = clip.write.mock.calls[0]?.[0]?.[0] as Item
          expect(Object.keys(item.data).sort()).toEqual(['text/html', 'text/plain'])
        } finally {
          view.unmount()
        }
      },
    )
  })

  it('detects omission of the manual clipboard fallback', async () => {
    await detects('setManual(true)', 'setManual(false)', async (code) => {
      server()
      const clip = clipboard()
      clip.writeText.mockRejectedValue(new Error('denied'))
      const Picker = component(code)
      const view = render(<Picker {...props()} />)
      try {
        await choose()
        await preview()
        fireEvent.click(screen.getByRole('button', { name: 'Copy plain text' }))
        await screen.findByText(
          'Clipboard access was unavailable. Select and copy the complete plain-text preview manually.',
        )
        expect(
          screen.queryByText('The full plain text above includes every booking link.'),
        ).not.toBeNull()
      } finally {
        view.unmount()
      }
    })
  })

  it('detects relaxing the maximum in both the checkbox and state guard', async () => {
    async function assertion(code: string) {
      const offered = Array.from({ length: 11 }, (_, index) => {
        const start = Date.parse(START) + index * 30 * 60_000
        return {
          start: new Date(start).toISOString(),
          end: new Date(start + 30 * 60_000).toISOString(),
        }
      })
      fakeApi({ [ROUTE]: () => json(200, { data: offered }) })
      const Picker = component(code)
      const view = render(<Picker {...props()} />)
      try {
        await choose([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
        expect(screen.queryByText('Selected times: 10 (maximum 10)')).not.toBeNull()
        expect(available().getAllByRole<HTMLInputElement>('checkbox')[10]?.checked).toBe(false)
      } finally {
        view.unmount()
      }
    }
    await assertion(production)
    const mutant = mutate('if (current.length >= 10) return current', '').replace(
      'disabled={!checked && selected.length >= 10}',
      'disabled={false}',
    )
    expect(mutant).not.toContain('disabled={!checked && selected.length >= 10}')
    await expect(assertion(mutant)).rejects.toMatchObject({ name: 'AssertionError' })
    await assertion(production)
  })

  it('detects reverse chronological selected rows', async () => {
    await detects(
      'a.start.localeCompare(b.start)',
      'b.start.localeCompare(a.start)',
      async (code) => {
        const offered = [
          { start: START, end: END },
          { start: `${DAY}T10:00:00.000Z`, end: `${DAY}T10:30:00.000Z` },
        ]
        fakeApi({ [ROUTE]: () => json(200, { data: offered }) })
        const Picker = component(code)
        const view = render(<Picker {...props()} />)
        try {
          await choose([1, 0])
          const selected = within(
            screen.getByRole('group', { name: 'Selected times' }),
          ).getAllByRole('listitem')
          expect(selected[0]?.textContent).toContain(
            snippet.formatSlotLabel(START, END, 'en', PROFILE.timeZone),
          )
        } finally {
          view.unmount()
        }
      },
    )
  })

  it('detects a display-language edit clearing selected instants', async () => {
    await detects(
      'setLocale(change.target.value as InterfaceLanguage)',
      'setLocale(change.target.value as InterfaceLanguage); setSelected([])',
      async (code) => {
        const client = server()
        const Picker = component(code)
        const view = render(<Picker {...props()} />)
        try {
          await choose()
          await preview()
          fireEvent.change(screen.getByRole('combobox', { name: 'Email language' }), {
            target: { value: 'fr' },
          })
          expect(screen.queryByText('Selected times: 1 (maximum 10)')).not.toBeNull()
          expect(client.to(ROUTE)).toHaveLength(1)
        } finally {
          view.unmount()
        }
      },
    )
  })

  it('detects unknown day reads converted into no availability', async () => {
    await detects(
      'if (!controller.signal.aborted) setLoadError(true)',
      'if (!controller.signal.aborted) setOffered([])',
      async (code) => {
        fakeApi({ [ROUTE]: () => json(403, { error: 'forbidden' }) })
        const Picker = component(code)
        const view = render(<Picker {...props()} />)
        try {
          await waitFor(() => expect(screen.queryByText('Loading available times…')).toBeNull())
          expect(
            screen.queryByText('We could not load available times. Please try again.'),
          ).not.toBeNull()
          expect(screen.queryByText('No times are offered on this date.')).toBeNull()
        } finally {
          view.unmount()
        }
      },
    )
  })

  it('detects a late old day overwriting the current availability', async () => {
    await detects('if (controller.signal.aborted) return', '', async (code) => {
      const pending = later()
      const tomorrow = new Date(Date.parse(`${DAY}T00:00:00Z`) + 86400000)
        .toISOString()
        .slice(0, 10)
      const next = { start: `${tomorrow}T10:00:00.000Z`, end: `${tomorrow}T10:30:00.000Z` }
      fakeApi({
        [ROUTE]: ({ path }) =>
          dateKeyIn(
            Date.parse(new URL(path, location.origin).searchParams.get('start') ?? ''),
            PROFILE.timeZone,
          ) === DAY
            ? pending.response
            : json(200, { data: [next] }),
      })
      const Picker = component(code)
      const view = render(<Picker {...props()} />)
      try {
        fireEvent.change(screen.getByLabelText(`Availability date (${PROFILE.timeZone})`), {
          target: { value: tomorrow },
        })
        await choose()
        await pending.answer(json(200, { data: [{ start: START, end: END }] }))
        expect(
          available().queryByRole('checkbox', {
            name: snippet.formatSlotLabel(next.start, next.end, 'en', PROFILE.timeZone),
          }),
        ).not.toBeNull()
      } finally {
        view.unmount()
      }
    })
  })

  it('detects reusing a selection for a different saved event', async () => {
    await detects(
      '<Picker key={identity} {...props} />',
      '<Picker key="unchanging" {...props} />',
      async (code) => {
        server()
        const Picker = component(code)
        const value = props()
        const view = render(<Picker {...value} />)
        try {
          await choose()
          await preview()
          view.rerender(<Picker {...value} event={eventType({ id: 'different-event' })} />)
          expect(screen.queryByText('Selected times: 0 (maximum 10)')).not.toBeNull()
          expect(
            screen.queryByRole('textbox', { name: 'Complete plain-text email preview' }),
          ).toBeNull()
        } finally {
          view.unmount()
        }
      },
    )
  })

  it('detects offering preview with zero selected alternatives', async () => {
    await detects(
      'disabled={disabled || busy || !selected.length || stale.length > 0}',
      'disabled={disabled || busy || stale.length > 0}',
      async (code) => {
        server()
        const Picker = component(code)
        const view = render(<Picker {...props()} />)
        try {
          expect(
            screen.getByRole<HTMLButtonElement>('button', { name: 'Preview email' }).disabled,
          ).toBe(true)
        } finally {
          view.unmount()
        }
      },
    )
  })

  it('detects preview generation without a fresh access check', async () => {
    const before =
      '      await verifyAccess()\n      if (!current()) return\n      setPreviewSource({ title: event.title, address })'
    await detects(before, before.replace('      await verifyAccess()\n', ''), async (code) => {
      server()
      const Picker = component(code)
      const verifyAccess = vi.fn(async () => {
        throw new Error('removed_manager')
      })
      const view = render(<Picker {...props({ verifyAccess })} />)
      try {
        await choose()
        fireEvent.click(screen.getByRole('button', { name: 'Preview email' }))
        await waitFor(() =>
          expect(screen.queryByText('Checking that you can preview these times…')).toBeNull(),
        )
        expect(
          screen.queryByRole('textbox', { name: 'Complete plain-text email preview' }),
        ).toBeNull()
        expect(
          screen.queryByText(
            'We could not prepare the preview. Nothing was copied. Please try again.',
          ),
        ).not.toBeNull()
      } finally {
        view.unmount()
      }
    })
  })

  it('detects delayed preview completion after a context change', async () => {
    const before =
      '    const current = () =>\n      !controller.signal.aborted && version.current === requestVersion && !blocked.current\n    setBusy(true)\n    setPreviewVisible(false)'
    await detects(
      before,
      '    const current = () => true\n    setBusy(true)\n    setPreviewVisible(false)',
      async (code) => {
        server()
        let answer = () => {}
        const pending = new Promise<void>((resolve) => {
          answer = resolve
        })
        const Picker = component(code)
        const value = props({ verifyAccess: () => pending })
        const view = render(<Picker {...value} />)
        try {
          await choose()
          fireEvent.click(screen.getByRole('button', { name: 'Preview email' }))
          await screen.findByText('Checking that you can preview these times…')
          view.rerender(<Picker {...value} disabled={true} />)
          await react.act(async () => {
            answer()
            await pending
          })
          expect(
            screen.queryByRole('textbox', { name: 'Complete plain-text email preview' }),
          ).toBeNull()
        } finally {
          view.unmount()
        }
      },
    )
  })

  it.each(['plain', 'rich'] as const)(
    'detects deferring the %s clipboard call beyond the click activation',
    async (kind) => {
      await detects(
        'writing = navigator.clipboard.write([item])',
        'writing = Promise.resolve().then(() => navigator.clipboard.write([item]))',
        async (code) => {
          server()
          const clip = promiseClipboard()
          let release = () => {}
          const pending = new Promise<void>((resolve) => {
            release = resolve
          })
          const verifyAccess = vi.fn(async () => {})
          const Picker = component(code)
          const view = render(<Picker {...props({ verifyAccess })} />)
          try {
            await choose()
            await preview()
            verifyAccess.mockImplementationOnce(() => pending)
            fireEvent.click(
              screen.getByRole('button', {
                name: kind === 'plain' ? 'Copy plain text' : 'Copy rich text',
              }),
            )
            expect(clip.write).toHaveBeenCalledOnce()
          } finally {
            await react.act(async () => {
              release()
              await pending
            })
            view.unmount()
          }
        },
      )
    },
  )

  it('detects resolving the clipboard data after a recheck failure', async () => {
    await detects(
      'rejectSnippet(error)',
      "resolveSnippet({ text: 'unchecked', html: '<p>unchecked</p>' })",
      async (code) => {
        let recheck = false
        fakeApi({
          [META]: () => json(200, publicEvent),
          [ROUTE]: () => json(200, { data: recheck ? [] : [{ start: START, end: END }] }),
        })
        const clip = promiseClipboard()
        const Picker = component(code)
        const view = render(<Picker {...props()} />)
        try {
          await choose()
          await preview()
          recheck = true
          fireEvent.click(screen.getByRole('button', { name: 'Copy rich text' }))
          await waitFor(() => expect(screen.queryByText('Checking selected times…')).toBeNull())
          const item = clip.write.mock.calls[0]?.[0]?.[0] as PromiseItem
          const result = await Promise.allSettled(item.types.map((type) => item.getType(type)))
          expect(result.map(({ status }) => status)).toEqual(['rejected', 'rejected'])
        } finally {
          view.unmount()
        }
      },
    )
  })

  it('detects accepting a legacy constructor that stringifies promise data', async () => {
    await detects(
      'value.size === probe.size && value.type === probe.type',
      'true',
      async (code) => {
        server()
        const clip = clipboard()
        class LegacyItem {
          value: Blob
          constructor(data: Record<string, unknown>) {
            this.value = new Blob([String(data['text/plain'])], { type: 'text/plain' })
          }
          async getType() {
            return this.value
          }
        }
        vi.stubGlobal('ClipboardItem', LegacyItem)
        const Picker = component(code)
        const view = render(<Picker {...props()} />)
        try {
          await choose()
          await preview()
          fireEvent.click(screen.getByRole('button', { name: 'Copy rich text' }))
          await waitFor(() => expect(screen.queryByText('Checking selected times…')).toBeNull())
          expect(clip.write).not.toHaveBeenCalled()
          expect(
            screen.queryByText(
              'Clipboard access was unavailable. Select and copy the complete plain-text preview manually.',
            ),
          ).not.toBeNull()
        } finally {
          view.unmount()
        }
      },
    )
  })

  it('detects disabling the focused copy button while checking', async () => {
    const before =
      "disabled={disabled}\n              aria-disabled={busy}\n              onClick={(click) => {\n                click.currentTarget.focus()\n                void copy('plain')\n              }}"
    await detects(
      before,
      before.replace('disabled={disabled}', 'disabled={disabled || busy}'),
      async (code) => {
        server()
        clipboard()
        let release = () => {}
        const pending = new Promise<void>((resolve) => {
          release = resolve
        })
        const verifyAccess = vi.fn(async () => {})
        const Picker = component(code)
        const view = render(<Picker {...props({ verifyAccess })} />)
        try {
          await choose()
          await preview()
          verifyAccess.mockImplementationOnce(() => pending)
          const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Copy plain text' })
          react.act(() => button.focus())
          fireEvent.click(button)
          expect(button.disabled).toBe(false)
          expect(document.activeElement).toBe(button)
        } finally {
          await react.act(async () => {
            release()
            await pending
          })
          view.unmount()
        }
      },
    )
  })

  it('detects losing focus when the stale preview controls are removed', async () => {
    await detects('retry.current?.focus()', '', async (code) => {
      let recheck = false
      fakeApi({
        [META]: () => json(200, publicEvent),
        [ROUTE]: () => json(200, { data: recheck ? [] : [{ start: START, end: END }] }),
      })
      clipboard()
      const Picker = component(code)
      const view = render(<Picker {...props()} />)
      try {
        await choose()
        await preview()
        recheck = true
        const button = screen.getByRole('button', { name: 'Copy plain text' })
        react.act(() => button.focus())
        fireEvent.click(button)
        await waitFor(() => expect(screen.queryByText('Checking selected times…')).toBeNull())
        expect(document.activeElement).toBe(
          screen.getByRole('button', { name: 'Check availability again' }),
        )
      } finally {
        view.unmount()
      }
    })
  })

  it.each(['plain', 'rich'] as const)(
    'detects omitting focus on the %s copy click',
    async (kind) => {
      const before = `click.currentTarget.focus()\n                void copy('${kind}')`
      await detects(before, `void copy('${kind}')`, async (code) => {
        server()
        clipboard()
        const Picker = component(code)
        const view = render(<Picker {...props()} />)
        try {
          await choose()
          await preview()
          const button = screen.getByRole('button', {
            name: kind === 'plain' ? 'Copy plain text' : 'Copy rich text',
          })
          expect(document.activeElement).not.toBe(button)
          fireEvent.click(button)
          expect(document.activeElement).toBe(button)
        } finally {
          view.unmount()
        }
      })
    },
  )

  it('detects hiding the focus recovery button while the new display day loads', async () => {
    const start = production.lastIndexOf('<button', production.indexOf('ref={retry}'))
    const end = production.indexOf('</button>', start) + '</button>'.length
    const before = production.slice(start, end)
    await detects(before, `{!loading && (${before})}`, async (code) => {
      let loadingDay = false
      const pending = later()
      fakeApi({
        [META]: () => json(200, publicEvent),
        [ROUTE]: ({ path }) => {
          const query = new URL(path, location.origin).searchParams
          const exact =
            Date.parse(query.get('end') ?? '') - Date.parse(query.get('start') ?? '') ===
            30 * 60_000
          return loadingDay
            ? exact
              ? json(200, { data: [] })
              : pending.response
            : json(200, { data: [{ start: START, end: END }] })
        },
      })
      clipboard()
      const Picker = component(code)
      const view = render(<Picker {...props()} />)
      try {
        await choose()
        await preview()
        loadingDay = true
        fireEvent.change(screen.getByLabelText(`Availability date (${PROFILE.timeZone})`), {
          target: { value: addDays(DAY, 1) },
        })
        const button = screen.getByRole('button', { name: 'Copy plain text' })
        react.act(() => button.focus())
        fireEvent.click(button)
        await waitFor(() => expect(screen.queryByText('Checking selected times…')).toBeNull())
        expect(screen.queryByRole('button', { name: 'Check availability again' })).not.toBeNull()
        expect(document.activeElement).not.toBe(document.body)
      } finally {
        await pending.answer(json(200, { data: [] }))
        view.unmount()
      }
    })
  })

  it('detects removing the availability-failure live region', async () => {
    const before =
      '<p role="alert">{t(\'We could not load available times. Please try again.\')}</p>'
    await detects(before, before.replace(' role="alert"', ''), async (code) => {
      fakeApi({ [ROUTE]: () => json(403, { error: 'forbidden' }) })
      const Picker = component(code)
      const view = render(<Picker {...props()} />)
      try {
        await screen.findByText('We could not load available times. Please try again.')
        expect(screen.queryByRole('alert')).not.toBeNull()
      } finally {
        view.unmount()
      }
    })
  })

  it('detects omitting the ready-preview announcement', async () => {
    await detects("setStatus('Email preview ready.')", 'setStatus(null)', async (code) => {
      server()
      const Picker = component(code)
      const view = render(<Picker {...props()} />)
      try {
        await choose()
        await preview()
        expect(screen.queryByText('Email preview ready.')?.closest('[role="status"]')).toBeTruthy()
      } finally {
        view.unmount()
      }
    })
  })

  it('detects offering browser zones rejected by the formatter', async () => {
    await detects('snippetTimeZone(zone)', 'void zone', async (code) => {
      server()
      const Picker = component(code)
      const view = render(<Picker {...props()} />)
      try {
        const select = screen.getByRole<HTMLSelectElement>('combobox', {
          name: 'Display time zone',
        })
        expect([...select.options].map(({ value }) => value)).not.toContain('EST5EDT')
      } finally {
        view.unmount()
      }
    })
  })

  it('detects replacing a label-format failure with an empty label', async () => {
    await detects(
      "return t('This time could not be displayed. Please try another display time zone.')",
      "return ''",
      async (code) => {
        server()
        const Picker = component(code, {
          formatSlotLabel: () => {
            throw new RangeError('Intl failure')
          },
        })
        const view = render(<Picker {...props()} />)
        try {
          await choose()
          expect(
            available().queryByRole('checkbox', {
              name: 'This time could not be displayed. Please try another display time zone.',
            }),
          ).not.toBeNull()
        } finally {
          view.unmount()
        }
      },
    )
  })

  it.each([
    [
      'dateKeyIn(Date.now(), displayTimeZone)',
      'new Date(Date.now()).toISOString().slice(0, 10)',
      'Pacific/Kiritimati',
      '2026-03-07T12:30:00Z',
      '2026-03-08',
    ],
    [
      'instantOf(parseDateKey(date), 0, 0, displayTimeZone)',
      "Date.parse(date + 'T00:00:00Z')",
      'Pacific/Kiritimati',
      '2026-03-07T12:30:00Z',
      '2026-03-08',
    ],
    [
      'instantOf(parseDateKey(addDays(date, 1)), 0, 0, displayTimeZone)',
      'start + 86_400_000',
      'America/Los_Angeles',
      '2026-03-09T01:00:00Z',
      '2026-03-08',
    ],
  ] as const)('detects UTC date arithmetic replacing %s', async (before, after, zone, now, day) => {
    await detects(before, after, async (code) => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now))
      const client = fakeApi({ [ROUTE]: () => json(200, { data: [] }) })
      const Picker = component(code)
      const view = render(<Picker {...props({ profile: { ...PROFILE, timeZone: zone } })} />)
      try {
        await waitFor(() => expect(screen.queryByText('Loading available times…')).toBeNull())
        expect(screen.getByLabelText<HTMLInputElement>(`Availability date (${zone})`).value).toBe(
          day,
        )
        const query = new URL(client.to(ROUTE)[0]?.path ?? '', location.origin).searchParams
        expect(Date.parse(query.get('start') ?? '')).toBe(instantOf(parseDateKey(day), 0, 0, zone))
        expect(Date.parse(query.get('end') ?? '')).toBe(
          instantOf(parseDateKey(addDays(day, 1)), 0, 0, zone) + 30 * 60_000,
        )
      } finally {
        view.unmount()
      }
    })
  })

  it.each([
    [
      'invalid_title',
      'The saved event title is invalid. Reload the saved event type and try again.',
    ],
    [
      'invalid_address',
      'The saved booking link is invalid. Reload the saved event type and try again.',
    ],
    [
      'snippet_too_large',
      'The email preview could not be created. Please choose fewer times and try again.',
    ],
    [
      'invalid_slots',
      'The email preview could not be created. Reload the saved event type and try again.',
    ],
  ] as const)('detects losing the accurate %s formatting message', async (cause, message) => {
    const before =
      cause === 'invalid_slots' ? `return '${message}'` : `if (error.code === '${cause}')`
    const after =
      cause === 'invalid_slots'
        ? "return 'The email preview could not be created. Please choose fewer times and try again.'"
        : 'if (false)'
    await detects(before, after, async (code) => {
      server()
      const Picker = component(code, {
        formatSlotSnippet: () => {
          throw new snippet.SlotSnippetError(cause)
        },
      })
      const view = render(<Picker {...props()} />)
      try {
        await choose()
        fireEvent.click(screen.getByRole('button', { name: 'Preview email' }))
        await waitFor(() =>
          expect(screen.queryByText('Checking that you can preview these times…')).toBeNull(),
        )
        expect(screen.queryByRole('alert')?.textContent).toBe(message)
      } finally {
        view.unmount()
      }
    })
  })
})
