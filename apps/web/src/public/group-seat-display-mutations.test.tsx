import { readFileSync } from 'node:fs'
import { render, screen, waitFor } from '@testing-library/react'
import * as react from 'react'
import { expect, it, vi } from 'vitest'
import * as zone from '../components/TimeZonePicker.tsx'
import * as runtime from '../i18n/runtime.tsx'
import { compileSourceCopy } from '../test/compile-source-copy.ts'
import { slot } from '../test/public-fixtures.ts'
import * as api from './api.ts'
import * as factIcon from './BookingFactIcon.tsx'
import * as calendar from './calendar.ts'
import * as month from './MonthCalendar.tsx'
import type { SlotPicker } from './SlotPicker.tsx'
import * as time from './time.ts'
import * as waitlist from './waitlist-window.ts'

const source = readFileSync('apps/web/src/public/SlotPicker.tsx', 'utf8')
function copy(text: string): typeof SlotPicker {
  const dependencies: Record<string, unknown> = {
    react,
    './SlotPicker.css': {},
    '../components/TimeZonePicker.tsx': zone,
    '../i18n/runtime.tsx': runtime,
    './api.ts': api,
    './BookingFactIcon.tsx': factIcon,
    './calendar.ts': calendar,
    './MonthCalendar.tsx': month,
    './time.ts': time,
    './waitlist-window.ts': waitlist,
  }
  const code = compileSourceCopy('SlotPicker.tsx', text, {
    loader: 'tsx',
    format: 'cjs',
    jsxFactory: 'reactRuntime.createElement',
    jsxFragment: 'reactRuntime.Fragment',
  })
  const module = { exports: {} as { SlotPicker: typeof SlotPicker } }
  new Function('require', 'module', 'exports', 'reactRuntime', code)(
    (name: string) => {
      if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected import ${name}`)
      return dependencies[name]
    },
    module,
    module.exports,
    react,
  )
  return module.exports.SlotPicker
}

it('detects removing remaining-seat information from a production source copy', async () => {
  for (const mutated of [false, true]) {
    const Picker = copy(
      mutated ? source.replace('slot.seatsRemaining !== undefined', 'false') : source,
    )
    const view = render(
      <Picker
        load={async () => [{ ...slot('2026-11-02T14:00:00Z'), seatsRemaining: 1, capacity: 2 }]}
        durationMinutes={30}
        timeZone="UTC"
        onTimeZoneChange={vi.fn()}
        locale="en-US"
        now={Date.parse('2026-11-01T00:00:00Z')}
        selected={null}
        onSelect={vi.fn()}
        version={0}
        initialPosition={{ month: { year: 2026, month: 11 }, day: '2026-11-02' }}
      />,
    )
    await waitFor(() => expect(document.querySelector('.slot')).not.toBeNull())
    const assertion = () => expect(screen.queryByText('1 seat left')).not.toBeNull()
    if (mutated) expect(assertion).toThrow()
    else assertion()
    view.unmount()
  }
})
