import { readFileSync } from 'node:fs'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as React from 'react'
import {
  MemoryRouter,
  matchRoutes,
  UNSAFE_DataRouterContext,
  useLocation,
  useNavigate,
  useRoutes,
} from 'react-router'
import { expect, it, vi } from 'vitest'
import { compileSourceCopy } from '../../test/compile-source-copy.ts'
import { BookingPanelContext, useBookingPanel } from './BookingPanel.tsx'

function compile(source: string, name: string, bindings: Record<string, unknown>) {
  const javascript = compileSourceCopy(name, source, {
    loader: 'tsx',
    format: 'cjs',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
  })
  const entries = Object.entries(bindings).filter(
    ([key]) => key !== 'default' && /^[a-zA-Z_$][\w$]*$/.test(key),
  )
  return new Function(...entries.map(([key]) => key), javascript)(
    ...entries.map(([, value]) => value),
  ) as React.ComponentType
}
function Child({ children }: { children: React.ReactNode }) {
  return children
}
function List() {
  const panel = useBookingPanel()
  const [text, setText] = React.useState('Grace')
  return (
    <>
      <input aria-label="Search" value={text} onChange={(event) => setText(event.target.value)} />
      <button type="button" onClick={(event) => panel?.open('first', event.currentTarget)}>
        Open first
      </button>
      {panel?.active && (
        <button type="button" onClick={panel.close}>
          Close
        </button>
      )}
    </>
  )
}
function Controls({ previous, next }: { previous: () => void; next: () => void }) {
  return (
    <>
      <button type="button" onClick={previous}>
        Previous
      </button>
      <button type="button" onClick={next}>
        Next
      </button>
    </>
  )
}
function Empty() {
  return null
}
const appSource = readFileSync('apps/web/src/App.tsx', 'utf8')
function appCopy(source: string) {
  return compile(
    `${source.slice(source.indexOf('function AppRoutes()'))}\nreturn AppRoutes`,
    'apps/web/src/App.tsx',
    {
      React,
      ...React,
      useLocation,
      useNavigate,
      useRoutes,
      matchRoutes,
      appRoutes: [
        { path: '/app/bookings', element: <List /> },
        { path: '/app/bookings/:id', element: <p>Detail</p> },
      ],
      routingFormRoutes: [
        { path: '/route/:handle/:slug' },
        { path: '/route/team/:teamSlug/:slug' },
      ],
      RoutingFormGate: Empty,
      BookingPanelContext,
      bookingPath: (id: string) => `/app/bookings/${id}`,
      useI18n: () => ({ t: (text: string) => text }),
      RouteErrorBoundary: Child,
      AdminLoading: Empty,
      RouteLoadingStatus: Empty,
    },
  )
}
function checkRouting(source: string, protection: 'state' | 'focus') {
  const Copy = appCopy(source)
  try {
    render(
      <MemoryRouter initialEntries={['/app/bookings?q=Grace']}>
        <Copy />
      </MemoryRouter>,
    )
    const input = screen.getByRole('textbox', { name: 'Search' })
    fireEvent.change(input, { target: { value: 'Grace Hopper' } })
    const trigger = screen.getByRole('button', { name: 'Open first' })
    trigger.focus()
    fireEvent.click(trigger)
    if (protection === 'state')
      expect(screen.queryByRole('textbox', { name: 'Search' })).toBe(input)
    const close = screen.getByRole('button', { name: 'Close' })
    close.focus()
    fireEvent.click(close)
    if (protection === 'state') {
      expect(screen.getByRole('textbox', { name: 'Search' })).toBe(input)
      expect((input as HTMLInputElement).value).toBe('Grace Hopper')
    } else expect(document.activeElement).toBe(trigger)
  } finally {
    cleanup()
  }
}
it.each([
  ['state', 'active ? background : location', 'location'],
  ['focus', 'opener.current?.focus({ preventScroll: true })', 'undefined'],
] as const)(
  'detects removing list %s protection in the routing source copy',
  (protection, before, after) => {
    expect(appSource.split(before)).toHaveLength(2)
    checkRouting(appSource, protection)
    expect(() => checkRouting(appSource.replace(before, after), protection)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    checkRouting(appSource, protection)
  },
)

it('detects reversing previous/next order in the host list source copy', async () => {
  const source = readFileSync('apps/web/src/pages/bookings/Bookings.tsx', 'utf8')
  const start = source.indexOf('      {selectedId && panel && (')
  const end = source.indexOf('\n      )}', start) + '\n      )}'.length
  const fragment = source.slice(start, end)
  function copy(text: string, calls: string[]) {
    return compile(
      `function Copy(){return <>${text}</>}\nreturn Copy`,
      'apps/web/src/pages/bookings/Bookings.tsx',
      {
        React,
        selectedId: 'middle',
        selectedIndex: 1,
        selected: { title: 'middle', start: '' },
        shown: { bookings: [{ id: 'first' }, { id: 'middle' }, { id: 'last' }], nextCursor: null },
        panel: { step: (id: string) => calls.push(id) },
        BookingPanel: Controls,
        BookingDetailPage: Empty,
        updateRow: () => {},
        moreError: null,
        ui: (x: string) => x,
        t: (x: string) => x,
        bookingTitle: () => 'middle',
        format: { dateTime: () => '' },
        loadMore: () => Promise.resolve(undefined),
      },
    )
  }
  function check(text: string) {
    const calls: string[] = []
    const Copy = copy(text, calls)
    try {
      render(<Copy />)
      fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(calls).toEqual(['first', 'last'])
    } finally {
      cleanup()
    }
  }
  expect(fragment.split('selectedIndex + 1')).toHaveLength(2)
  check(fragment)
  expect(() => check(fragment.replace('selectedIndex + 1', 'selectedIndex - 1'))).toThrowError(
    expect.objectContaining({ name: 'AssertionError' }),
  )
  check(fragment)
})

it('detects removing the narrow viewport switch in a rendered panel source copy', () => {
  const source = readFileSync('apps/web/src/pages/bookings/BookingPanel.tsx', 'utf8')
  const before = "window.matchMedia?.('(max-width: 767px)').matches ?? false"
  expect(source.split(before)).toHaveLength(2)
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }))
  function check(text: string) {
    const code = text
      .replace(/^import[\s\S]*?from '[^']+'$/gm, '')
      .replace(/^import '[^']+'$/gm, '')
      .replace(/^export /gm, '')
    const Copy = compile(
      `${code}\nreturn () => <BookingPanel name="Mobile booking">Details</BookingPanel>`,
      'apps/web/src/pages/bookings/BookingPanel.tsx',
      {
        React,
        ...React,
        UNSAFE_DataRouterContext,
        useI18n: () => ({ t: (x: string) => x }),
        useConfirmLeave: () => () => true,
      },
    )
    try {
      render(<Copy />)
      expect(screen.queryByRole('dialog', { name: 'Mobile booking' })).toBeNull()
      expect(screen.getByRole('region', { name: 'Mobile booking' }).className).toContain(
        'booking-detail-full-page',
      )
    } finally {
      cleanup()
    }
  }
  check(source)
  expect(() => check(source.replace(before, 'false'))).toThrowError(
    expect.objectContaining({ name: 'AssertionError' }),
  )
  check(source)
})
