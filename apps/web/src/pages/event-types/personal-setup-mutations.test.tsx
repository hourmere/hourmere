import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import type { ComponentType } from 'react'
import * as react from 'react'
import { Link, MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import type { EventType, Schedule } from '../../api/resources.ts'
import { CopyButton } from '../../components/CopyButton.tsx'
import { useLoad, useMounted } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import * as paths from '../../paths.ts'
import { ME, PROFILE } from '../../test/fake-api.tsx'
import { eventType, schedule } from '../../test/fixtures.ts'
import { validDefault } from '../availability/valid-default.ts'

const source = readFileSync('apps/web/src/pages/event-types/PersonalSetupGuide.tsx', 'utf8')
const guideSource = source.slice(source.indexOf('/** Derived'))
const listSource = readFileSync('apps/web/src/pages/event-types/EventTypes.tsx', 'utf8')
const loadSource = listSource.slice(
  listSource.indexOf('function useEventTypesLoad()'),
  listSource.indexOf('export function EventTypesPage()'),
)
const pageSource = listSource.slice(
  listSource.indexOf('export function EventTypesPage()'),
  listSource.indexOf('function EventTypeTable('),
)
const OTHER = { ...ME, user: { ...ME.user, id: '00000000-0000-7000-8000-000000000099' } }
const COMPLETE = 'Your booking page is ready'
const URL = `${window.location.origin}/ada/intro-call`

function copy<T>(code: string, exported: string, dependencies: Record<string, unknown>): T {
  const bindings = Object.entries(dependencies).filter(
    ([key]) => key !== 'default' && /^[A-Za-z_$][\w$]*$/.test(key),
  )
  const compiled = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { readFileSync } from 'node:fs'; import { transformSync } from 'esbuild'; process.stdout.write(transformSync(readFileSync(0, 'utf8'), { loader: 'tsx', format: 'cjs', jsxFactory: 'reactRuntime.createElement', jsxFragment: 'reactRuntime.Fragment' }).code)",
    ],
    { input: code.replace(/^export /gm, ''), encoding: 'utf8' },
  )
  return new Function(
    'reactRuntime',
    ...bindings.map(([key]) => key),
    `${compiled}; return ${exported}`,
  )(react, ...bindings.map(([, value]) => value)) as T
}

function mutate(code: string, before: string, after: string) {
  expect(code.split(before)).toHaveLength(2)
  return code.replace(before, after)
}

function clearPreferences() {
  for (const user of [ME, OTHER]) {
    for (const flag of ['calendar-skipped', 'completion-dismissed', 'inactive-dismissed']) {
      localStorage.removeItem(`hourmere-personal-setup:${user.user.id}:${flag}`)
    }
  }
}
afterEach(clearPreferences)

type GuideProps = {
  me: typeof ME
  profile: typeof PROFILE
  schedules: Schedule[]
  eventTypes: EventType[]
  reload: () => void
}
function guide(code: string) {
  return copy<ComponentType<GuideProps>>(code, 'PersonalSetupGuide', {
    ...react,
    ...paths,
    Link,
    CopyButton,
    useI18n,
    useMounted,
    validDefault,
  })
}
function showGuide(Guide: ComponentType<GuideProps>, events = [eventType()], me = ME) {
  return render(
    <MemoryRouter>
      <Guide
        me={me}
        profile={PROFILE}
        schedules={[schedule()]}
        eventTypes={events}
        reload={() => {}}
      />
    </MemoryRouter>,
  )
}
function assertCompletion(code: string, visibleUrl = false) {
  const view = showGuide(guide(code))
  try {
    const complete = screen.queryByRole('region', { name: COMPLETE })
    expect(complete).not.toBeNull()
    if (visibleUrl) expect(within(complete as HTMLElement).queryByText(URL)).not.toBeNull()
    expect(
      within(complete as HTMLElement).queryByRole('button', { name: 'Copy booking link' }),
    ).not.toBeNull()
  } finally {
    view.unmount()
  }
}

function assertInactive(code: string) {
  const view = showGuide(guide(code), [eventType({ isActive: false })])
  try {
    expect(screen.queryByRole('complementary', { name: 'No active event type' })).not.toBeNull()
    expect(screen.queryByRole('region', { name: 'Set up your booking page' })).toBeNull()
  } finally {
    view.unmount()
  }
}

function assertPreference(
  code: string,
  preference: 'calendar' | 'completion' | 'inactive',
  isolate = false,
) {
  clearPreferences()
  const Guide = guide(code)
  const events =
    preference === 'calendar' ? [] : [eventType({ isActive: preference !== 'inactive' })]
  const first = showGuide(Guide, events)
  fireEvent.click(
    screen.getByRole('button', { name: preference === 'calendar' ? 'Skip for now' : 'Dismiss' }),
  )
  first.unmount()
  const user = isolate ? OTHER : ME
  const nextEvents = events.map((event) => ({ ...event, ownerUserId: user.user.id }))
  const next = showGuide(Guide, nextEvents, user)
  try {
    if (preference === 'calendar') {
      expect(screen.queryByRole('button', { name: 'Skip for now' }) !== null).toBe(isolate)
    } else {
      expect(
        screen.queryByRole(preference === 'completion' ? 'region' : 'complementary', {
          name: preference === 'completion' ? COMPLETE : 'No active event type',
        }) !== null,
      ).toBe(isolate)
    }
  } finally {
    next.unmount()
    clearPreferences()
  }
}

async function assertRetainedRefresh(code: string) {
  let loaded = false
  const data = { eventTypes: [eventType()], profile: PROFILE, schedules: [] }
  const usePage = copy<
    () => readonly [{ status: string; data?: typeof data }, () => void, string | null]
  >(code, 'useEventTypesLoad', {
    ...react,
    useLoad,
    errorMessage: () => 'Offline',
    loadPage: async () => {
      if (loaded) throw new TypeError('Offline')
      loaded = true
      return data
    },
  })
  const view = renderHook(usePage)
  try {
    await waitFor(() => expect(view.result.current[0].status).toBe('ready'))
    act(() => view.result.current[1]())
    await waitFor(() =>
      expect(view.result.current[2] !== null || view.result.current[0].status === 'error').toBe(
        true,
      ),
    )
    expect(view.result.current[0].status).toBe('ready')
    expect(view.result.current[0].data).toBe(data)
    expect(view.result.current[2]).toBe('Offline')
  } finally {
    view.unmount()
  }
}

const Empty = () => null
const ReloadGuide = ({ reload }: { reload: () => void }) => (
  <button type="button" onClick={reload}>
    Refresh guide
  </button>
)
const ReadinessVersion = ({ readinessVersion }: { readinessVersion: number }) => (
  <output aria-label="Readiness refresh">{readinessVersion}</output>
)

function assertGuideReload(code: string) {
  const Page = copy<ComponentType>(code, 'EventTypesPage', {
    ...react,
    ...paths,
    Link,
    validDefault,
    useI18n: () => ({ t: (text: string) => text, uiText: (text: string) => text }),
    useMe: () => ME,
    usePageTitle: () => {},
    useFlash: () => '',
    useSearchParams: () => [new URLSearchParams()],
    useEventTypesLoad: () => [
      { status: 'ready', data: { eventTypes: [eventType()], profile: PROFILE, schedules: [] } },
      () => {},
      null,
    ],
    PageHeader: Empty,
    EmptyState: Empty,
    PageSkeleton: Empty,
    PersonalSetupGuide: ReloadGuide,
    EventTypeTable: ReadinessVersion,
  })
  const view = render(
    <MemoryRouter>
      <Page />
    </MemoryRouter>,
  )
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Refresh guide' }))
    expect(screen.getByLabelText('Readiness refresh').textContent).toBe('1')
  } finally {
    view.unmount()
  }
}

describe('personal setup source-copy negative controls', () => {
  it('detects inconsistent booking handle terminology', () => {
    function assertHandle(code: string) {
      const view = showGuide(guide(code), [], { ...ME, user: { ...ME.user, name: '' } })
      try {
        expect(
          screen.queryByText('Choose your display name, handle and time zone in Settings.'),
        ).not.toBeNull()
      } finally {
        view.unmount()
      }
    }
    assertHandle(guideSource)
    const mutant = mutate(
      guideSource,
      'Choose your display name, handle and time zone in Settings.',
      'Choose your display name, booking username and time zone in Settings.',
    )
    expect(() => assertHandle(mutant)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    assertHandle(guideSource)
  })

  it('detects hiding the completed guide before the user dismisses it', () => {
    assertCompletion(guideSource)
    const mutant = mutate(
      guideSource,
      'return completionDismissed ? null : (',
      'return true ? null : (',
    )
    expect(() => assertCompletion(mutant)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    assertCompletion(guideSource)
  })

  it('detects removing the selectable URL used by the manual-copy fallback', () => {
    assertCompletion(guideSource, true)
    const mutant = mutate(guideSource, '<p className="mono user-content">{url}</p>', '<p />')
    expect(() => assertCompletion(mutant, true)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    assertCompletion(guideSource, true)
  })

  it.each(['calendar', 'completion', 'inactive'] as const)(
    'detects losing the remembered %s preference',
    (preference) => {
      assertPreference(guideSource, preference)
      const mutant = mutate(guideSource, "return localStorage.getItem(key) === '1'", 'return false')
      expect(() => assertPreference(mutant, preference)).toThrowError(
        expect.objectContaining({ name: 'AssertionError' }),
      )
      assertPreference(guideSource, preference)
    },
  )

  it.each(['calendar', 'completion', 'inactive'] as const)(
    'detects sharing the %s preference between users',
    (preference) => {
      assertPreference(guideSource, preference, true)
      // biome-ignore lint/suspicious/noTemplateCurlyInString: replace literal source code
      const mutant = mutate(guideSource, '${userId}:${preference}', '${preference}')
      // The deliberately unscoped key is owned only by this control.
      try {
        expect(() => assertPreference(mutant, preference, true)).toThrowError(
          expect.objectContaining({ name: 'AssertionError' }),
        )
      } finally {
        localStorage.removeItem(
          `hourmere-personal-setup:${preference === 'calendar' ? 'calendar-skipped' : `${preference}-dismissed`}`,
        )
      }
      assertPreference(guideSource, preference, true)
    },
  )

  it('detects reopening the whole guide when configured event types are inactive', () => {
    assertInactive(guideSource)
    const mutant = mutate(
      guideSource,
      'if (profileDone && availabilityDone && firstEvent && !activeEvent)',
      'if (false)',
    )
    expect(() => assertInactive(mutant)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    assertInactive(guideSource)
  })

  it('detects replacing loaded page data with a refresh failure', async () => {
    await assertRetainedRefresh(loadSource)
    const mutant = mutate(loadSource, 'if (!previous.current) throw error', 'if (true) throw error')
    await expect(assertRetainedRefresh(mutant)).rejects.toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    await assertRetainedRefresh(loadSource)
  })

  it('detects omitting the readiness refresh from the guide reload', () => {
    assertGuideReload(pageSource)
    const mutant = mutate(
      pageSource,
      'setReadinessVersion((version) => version + 1)',
      'setReadinessVersion((version) => version)',
    )
    expect(() => assertGuideReload(mutant)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    assertGuideReload(pageSource)
  })
})
