import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as react from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ErrorSummary, Field, FieldError } from '../components/forms.tsx'
import { TimeZonePicker } from '../components/TimeZonePicker.tsx'
import { useI18n } from '../i18n/runtime.tsx'
import { compileSourceCopy } from '../test/compile-source-copy.ts'
import { codeOf, failureMessage, loadSlotsInRange } from './api.ts'
import * as calendar from './calendar.ts'
import { MonthCalendar } from './MonthCalendar.tsx'
import { FocusHeading } from './PublicLayout.tsx'
import type { SlotPicker } from './SlotPicker.tsx'
import * as time from './time.ts'
import { emailError, nameError } from './validation.ts'
import type { WaitlistJoin } from './WaitlistJoin.tsx'
import * as windowFunctions from './waitlist-window.ts'

const windowSource = readFileSync('apps/web/src/public/waitlist-window.ts', 'utf8')
const pickerSource = readFileSync('apps/web/src/public/SlotPicker.tsx', 'utf8')
const joinSource = readFileSync('apps/web/src/public/WaitlistJoin.tsx', 'utf8')
const at = Date.parse('2026-11-01T04:30:00Z')
const preferredWindow = {
  start: '2026-11-02T05:00:00Z',
  end: '2026-11-03T05:00:00Z',
  timeZone: 'America/New_York',
}
function copy<T>(source: string, value: string, dependencies: Record<string, unknown>): T {
  const entries = Object.entries(dependencies).filter(
    ([name]) => name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name),
  )
  const compiled = compileSourceCopy(
    value,
    source
      .replace(/^import[\s\S]*?from '[^']+'$/gm, '')
      .replace(/^import '[^']+'$/gm, '')
      .replace(/^export /gm, ''),
    {
      loader: 'tsx',
      format: 'cjs',
      jsxFactory: 'react.createElement',
      jsxFragment: 'react.Fragment',
    },
  )
  return new Function(...entries.map(([name]) => name), `${compiled}; return ${value}`)(
    ...entries.map(([, dependency]) => dependency),
  ) as T
}
function mutate(source: string, before: string, after: string) {
  expect(source.split(before), 'unique source mutation anchor').toHaveLength(2)
  return source.replace(before, after)
}
function detects(source: string, before: string, after: string, check: (source: string) => void) {
  check(source)
  expect(() => check(mutate(source, before, after))).toThrowError(
    expect.objectContaining({ name: 'AssertionError' }),
  )
  check(source)
}
const windowCopy = (source: string) =>
  copy<typeof windowFunctions>(source, '{ waitlistWindow, waitlistOfferEnabled }', {
    ...calendar,
    ...time,
  })

describe('public waitlist production-source mutation controls', () => {
  it.each([
    ['!oneTime && enabled === true', 'enabled === true', 'one-time'],
    ['!oneTime && enabled === true', '!oneTime', 'disabled'],
    [' && defaultDuration', '', 'duration'],
  ])('detects bypassed %s offer gate', (before, after, kind) => {
    detects(windowSource, before, after, (source) => {
      const enabled = windowCopy(source).waitlistOfferEnabled
      expect(
        kind === 'one-time'
          ? enabled(true, true)
          : kind === 'duration'
            ? enabled(false, true, false)
            : enabled(false, false),
      ).toBe(false)
      expect(enabled(false, true)).toBe(true)
    })
  })
  it('detects a past range being accepted', () =>
    detects(windowSource, 'if (end <= start) return null', 'if (false) return null', (source) => {
      expect(
        windowCopy(source).waitlistWindow({ year: 2026, month: 10 }, null, 'UTC', at),
      ).toBeNull()
    }))
  it('detects removing the 62-day bound', () =>
    detects(windowSource, 'Math.min(last, now + 62 * 86_400_000)', 'last', (source) => {
      expect(
        windowCopy(source).waitlistWindow({ year: 2027, month: 1 }, null, 'UTC', at)?.end,
      ).toBe(new Date(at + 62 * 86_400_000).toISOString())
    }))
  it('detects replacing calendar-day arithmetic with 24 elapsed hours', () =>
    detects(
      windowSource,
      'const last = instantOf(next, 0, 0, timeZone)',
      'const last = first + 86_400_000',
      (source) => {
        const range = windowCopy(source).waitlistWindow(
          { year: 2026, month: 11 },
          '2026-11-01',
          'America/New_York',
          at - 86_400_000,
        )
        expect(Date.parse(range?.end ?? '') - Date.parse(range?.start ?? '')).toBe(25 * 3_600_000)
      },
    ))
  it.each([
    [
      'ready && (day ? !daySlots.length : !available.size)',
      'true && (day ? !daySlots.length : !available.size)',
      'loading',
    ],
    ['day ? !daySlots.length : !available.size', 'day ? !daySlots.length : true', 'nonempty'],
  ])('detects offering enrollment for %s', async (before, after, kind) => {
    const check = async (source: string) => {
      const Picker = copy<typeof SlotPicker>(source, 'SlotPicker', {
        react,
        ...react,
        ...calendar,
        ...time,
        ...windowFunctions,
        useI18n,
        TimeZonePicker,
        MonthCalendar,
        failureMessage,
        loadSlotsInRange,
      })
      const load =
        kind === 'loading'
          ? () => new Promise<never>(() => {})
          : async () => [{ start: '2026-11-02T14:00:00Z', end: '2026-11-02T14:30:00Z' }]
      const view = render(
        <Picker
          load={load}
          durationMinutes={30}
          timeZone="America/New_York"
          onTimeZoneChange={() => {}}
          locale="en-US"
          now={at}
          initialPosition={{ month: { year: 2026, month: 11 }, day: null }}
          selected={null}
          onSelect={() => {}}
          version={0}
          renderWaitlist={() => <p>waitlist offer fixture</p>}
        />,
      )
      try {
        if (kind === 'nonempty') await screen.findByText('1 day has available times this month.')
        expect(screen.queryByText('waitlist offer fixture')).toBeNull()
      } finally {
        view.unmount()
      }
    }
    await check(pickerSource)
    await expect(check(mutate(pickerSource, before, after))).rejects.toMatchObject({
      name: 'AssertionError',
    })
    await check(pickerSource)
  })
  it.each([
    [
      'if (!ready || !autoAdvancePending) return',
      'if (renderWaitlist || !ready || !autoAdvancePending) return',
      'automatic advance',
    ],
    [' && !autoAdvancePending\n      ?', '\n      ?', 'transient empty range'],
  ])('detects waitlist regression in %s', async (before, after, kind) => {
    const check = async (source: string) => {
      const Picker = copy<typeof SlotPicker>(source, 'SlotPicker', {
        react,
        ...react,
        ...calendar,
        ...time,
        ...windowFunctions,
        useI18n,
        TimeZonePicker,
        MonthCalendar,
        failureMessage,
        loadSlotsInRange,
      })
      const slot = { start: '2026-12-05T14:00:00Z', end: '2026-12-05T14:30:00Z' }
      const offers: string[] = []
      const view = render(
        <Picker
          load={async (start, end) =>
            kind === 'automatic advance' &&
            Date.parse(slot.start) >= Date.parse(start) &&
            Date.parse(slot.end) <= Date.parse(end)
              ? [slot]
              : []
          }
          durationMinutes={30}
          timeZone="UTC"
          onTimeZoneChange={() => {}}
          locale="en-US"
          now={Date.parse('2026-11-30T12:00:00Z')}
          selected={null}
          onSelect={() => {}}
          version={0}
          renderWaitlist={(window) => {
            offers.push(window.start)
            return <p>waitlist offer fixture</p>
          }}
        />,
      )
      try {
        await act(async () => {})
        if (kind === 'automatic advance') {
          expect(screen.queryByRole('heading', { name: 'December 2026' })).not.toBeNull()
          expect(offers).toEqual([])
        } else {
          expect(screen.queryByRole('heading', { name: 'January 2027' })).not.toBeNull()
          expect(offers.length).toBeGreaterThan(0)
          expect(offers.every((start) => start === '2027-01-01T00:00:00.000Z')).toBe(true)
        }
      } finally {
        view.unmount()
      }
    }
    await check(pickerSource)
    await expect(check(mutate(pickerSource, before, after))).rejects.toMatchObject({
      name: 'AssertionError',
    })
    await check(pickerSource)
  })
  it.each([
    ['if (!consent)', 'if (false)', 'consent'],
    ['if (!resend && start < now())', 'if (false)', 'expired'],
    ['if (inFlight.current) return', 'if (false) return', 'duplicate'],
    ['<ErrorSummary errors={errors} message={error} attempt={attempt} />', '<div />', 'a11y'],
    [
      "'The host or the team’s owners and admins can see your email, name and requested period.'",
      "''",
      'disclosure',
    ],
  ])('detects weakening join %s', async (before, after, kind) => {
    const check = async (source: string) => {
      let current = at
      const join = vi.fn(async () => new Promise<never>(() => {}))
      const Join = copy<typeof WaitlistJoin>(source, 'WaitlistJoin', {
        react,
        ...react,
        ErrorSummary,
        Field,
        FieldError,
        useI18n,
        codeOf,
        failureMessage,
        joinWaitlist: join,
        resendWaitlistVerification: vi.fn(),
        now: () => current,
        FocusHeading,
        ...time,
        emailError,
        nameError,
      })
      const view = render(
        <Join handle="ada" slug="intro" team={false} window={preferredWindow} locale="en-US" />,
      )
      try {
        const user = userEvent.setup()
        await user.click(screen.getByRole('button', { name: 'Join the waitlist' }))
        if (kind === 'disclosure')
          expect(
            screen.queryByText(
              'The host or the team’s owners and admins can see your email, name and requested period.',
            ),
          ).not.toBeNull()
        if (kind !== 'a11y') await user.type(screen.getByLabelText('Email'), 'ada@example.invalid')
        if (kind === 'expired' || kind === 'duplicate')
          await user.click(screen.getByLabelText(/I agree to receive/))
        if (kind === 'expired') current = Date.parse(preferredWindow.start) + 1
        const form = screen.getByLabelText('Email').closest('form')
        if (!form) throw new Error('Expected waitlist form')
        fireEvent.submit(form)
        if (kind === 'duplicate') {
          fireEvent.submit(form)
          await waitFor(() => expect(join).toHaveBeenCalledTimes(1))
        } else if (kind === 'a11y') {
          expect(screen.queryByRole('alert')).not.toBeNull()
          expect(document.activeElement).toBe(screen.getByRole('alert'))
        } else expect(join).not.toHaveBeenCalled()
      } finally {
        view.unmount()
        cleanup()
      }
    }
    await check(joinSource)
    await expect(check(mutate(joinSource, before, after))).rejects.toMatchObject({
      name: 'AssertionError',
    })
    await check(joinSource)
  })
})
