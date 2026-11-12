import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as react from 'react'
import { describe, expect, it } from 'vitest'
import { RequestError } from '../../api/errors.ts'
import { compileSourceCopy } from '../../test/compile-source-copy.ts'
import { booking } from '../../test/public-fixtures.ts'
import type { RequestReschedule } from './RequestReschedule.tsx'

const source = readFileSync('apps/web/src/pages/bookings/RequestReschedule.tsx', 'utf8')
function Field({ children }: { children: (props: object) => react.ReactNode }) {
  return children({ 'aria-label': 'Note' })
}
function OrganizationContextConflict() {
  return null
}
function component(text: string, calls: unknown[]) {
  const compiled = compileSourceCopy(
    'apps/web/src/pages/bookings/RequestReschedule.tsx',
    text.replace(/^import[\s\S]*?from '[^']+'$/gm, '').replace(/^export /gm, ''),
    { loader: 'tsx', format: 'cjs', jsxFactory: 'react.createElement' },
  )
  let key = 0
  const deps = {
    react,
    useState: react.useState,
    useRef: react.useRef,
    api: {
      POST: async (_path: string, input: { body: unknown }) => {
        calls.push(input.body)
        throw new Error('uncertain')
      },
    },
    unwrap: (value: Promise<unknown>) => value,
    useMounted: () => react.useRef(true),
    useI18n: () => ({ t: (key: string) => key, ui: () => 'Error' }),
    useUnsavedChanges: () => {},
    randomKey: () => `key-${++key}`,
    msg: (key: string) => key,
    errorMessage: () => 'Error',
    isOrganizationContextChanged: () => false,
    RequestError,
    Field,
    OrganizationContextConflict,
  }
  return new Function(...Object.keys(deps), `${compiled}; return RequestReschedule`)(
    ...Object.values(deps),
  ) as typeof RequestReschedule
}
async function check(text: string, protection: 'bound' | 'replay') {
  const calls: unknown[] = []
  const Component = component(text, calls)
  try {
    render(
      <Component booking={booking()} expectedOrganizationId="organization" onChange={() => {}} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Request reschedule' }))
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: protection === 'bound' ? 'x'.repeat(2001) : 'Move please' },
    })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send request' })))
    if (protection === 'bound') expect(calls).toHaveLength(0)
    else {
      await waitFor(() => expect(calls).toHaveLength(1))
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Retry the same request' })),
      )
      await waitFor(() => expect(calls).toHaveLength(2))
      expect(calls[1]).toEqual(calls[0])
    }
  } finally {
    cleanup()
  }
}
describe('request form source-copy protections', () => {
  it.each([
    ['bound', 'note.length > 2000', 'false'],
    ['replay', 'attempt.current ??=', 'attempt.current ='],
  ] as const)('detects removing %s', async (protection, from, to) => {
    expect(source.split(from)).toHaveLength(2)
    await check(source, protection)
    await expect(check(source.replace(from, to), protection)).rejects.toMatchObject({
      name: 'AssertionError',
    })
    await check(source, protection)
  })
})

function RequestButton() {
  return <button type="button">Request reschedule</button>
}

it('detects offering a reschedule request for a group seat in the detail source copy', () => {
  const detail = readFileSync('apps/web/src/pages/bookings/BookingDetail.tsx', 'utf8')
  const start = detail.indexOf("      {!readOnly &&\n        booking.status === 'confirmed'")
  const end = detail.indexOf('\n\n      {!readOnly', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const section = detail.slice(start, end)
  expect(section.split('booking.isGroupSeat')).toHaveLength(2)
  function verify(text: string) {
    const compiled = compileSourceCopy(
      'apps/web/src/pages/bookings/BookingDetail.tsx',
      `function Copy(){return <>${text}</>}`,
      {
        loader: 'tsx',
        format: 'cjs',
        jsxFactory: 'react.createElement',
        jsxFragment: 'react.Fragment',
      },
    )
    const deps = {
      react,
      readOnly: false,
      started: false,
      booking: booking({ isGroupSeat: true }),
      expectedOrganizationId: 'organization',
      updateBooking: () => {},
      t: (key: string) => key,
      RequestReschedule: RequestButton,
    }
    const Copy = new Function(...Object.keys(deps), `${compiled}; return Copy`)(
      ...Object.values(deps),
    ) as react.ComponentType
    try {
      render(<Copy />)
      expect(screen.queryByRole('button', { name: 'Request reschedule' })).toBeNull()
      expect(
        screen.queryByText('Group-seat bookings do not support reschedule requests.'),
      ).not.toBeNull()
    } finally {
      cleanup()
    }
  }
  verify(section)
  expect(() => verify(section.replace('booking.isGroupSeat', 'false'))).toThrowError(
    expect.objectContaining({ name: 'AssertionError' }),
  )
  verify(section)
})
