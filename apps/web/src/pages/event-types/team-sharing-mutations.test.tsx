import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isPublicTeamSlug } from '@hourmere/core/reserved'
import { render, screen } from '@testing-library/react'
import * as react from 'react'
import { type ComponentType, useEffect, useRef } from 'react'
import { Link, MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { EventType } from '../../api/resources.ts'
import { CopyButton } from '../../components/CopyButton.tsx'
import * as paths from '../../paths.ts'
import { ME } from '../../test/fake-api.tsx'
import { eventType } from '../../test/fixtures.ts'
import { type TeamEventReadiness, teamReadinessAllowsSharing } from './event-readiness.ts'
import type { SavedEventShare } from './SavedEventShare.tsx'

const TEAM = { ...ME, organization: { ...ME.organization, personal: false, slug: 'Design-TEAM' } }
const EVENT = eventType({
  ownerUserId: null,
  schedulingType: 'round_robin',
  roundRobinActive: true,
})
const CHECK: TeamEventReadiness = {
  eventTypeId: EVENT.id,
  enablement: 'enabled',
  activation: 'active',
  summary: 'checks_passed',
  completeness: 'complete',
  evaluatedAt: '2026-10-31T12:00:00.000Z',
  reasonCodes: [],
  fixKinds: [],
}
const listSource = readFileSync('apps/web/src/pages/event-types/EventTypes.tsx', 'utf8')
const tableSource = listSource.slice(listSource.indexOf('function EventTypeTable('))
const shareSource = readFileSync('apps/web/src/pages/event-types/SavedEventShare.tsx', 'utf8')
const shareFunction = shareSource.slice(shareSource.indexOf('export function SavedEventShare('))

/** Compile production copies without writing or replacing any repository source. */
function copy<T>(source: string, exported: string, dependencies: Record<string, unknown>): T {
  const compiled = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { readFileSync } from 'node:fs'; import { transformSync } from 'esbuild'; process.stdout.write(transformSync(readFileSync(0, 'utf8'), { loader: 'tsx', format: 'cjs', jsxFactory: 'reactRuntime.createElement', jsxFragment: 'reactRuntime.Fragment' }).code)",
    ],
    { input: source.replace(/^export /gm, ''), encoding: 'utf8' },
  )
  return new Function(
    'reactRuntime',
    ...Object.keys(dependencies),
    `${compiled}; return ${exported}`,
  )(react, ...Object.values(dependencies)) as T
}

function mutate(source: string, before: string, after = '') {
  expect(source.split(before), 'mutation must match once').toHaveLength(2)
  return source.replace(before, after)
}

const common = {
  ...paths,
  Link,
  CopyButton,
  isPublicTeamSlug,
  useI18n: () => ({ t: (text: string) => text, locale: 'en' }),
  teamReadinessAllowsSharing,
}
const ConfigurationChecks = () => null

function table(source: string, item: TeamEventReadiness | undefined = CHECK) {
  return copy<ComponentType<{ eventTypes: EventType[]; me: typeof TEAM; profile: null }>>(
    source,
    'EventTypeTable',
    {
      ...common,
      useEventReadiness: () => [
        { status: 'ready', data: new Map(item ? [[EVENT.id, item]] : []) },
        () => {},
      ],
      formatMinutes: () => '30 min',
      ConfigurationChecks,
    },
  )
}

function share(source: string, role: 'owner' | null = 'owner') {
  return copy<typeof SavedEventShare>(source, 'SavedEventShare', {
    ...common,
    useEffect,
    useRef,
    useTeamManagementAccess: () => ({ status: 'ready', role }),
  })
}

function assertListHidden(
  source: string,
  event = EVENT,
  item: TeamEventReadiness | undefined = CHECK,
) {
  const Table = table(source, item)
  const view = render(
    <MemoryRouter>
      <Table eventTypes={[event]} me={TEAM} profile={null} />
    </MemoryRouter>,
  )
  try {
    expect(view.container.querySelector('a[href*="/team/"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy link for {0}' })).toBeNull()
  } finally {
    view.unmount()
  }
}

function assertShareHidden(source: string, event = EVENT, item: TeamEventReadiness = CHECK) {
  const Share = share(source)
  const view = render(
    <MemoryRouter>
      <Share
        event={event}
        me={TEAM}
        profile={null}
        schedules={[]}
        readiness={{ status: 'ready', item }}
        retryReadiness={() => {}}
      />
    </MemoryRouter>,
  )
  try {
    expect(screen.queryByRole('link', { name: /View booking page/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy booking link' })).toBeNull()
  } finally {
    view.unmount()
  }
}

describe('team sharing production-source negative controls', () => {
  it('detects an unconditional booking promise in the team editor visibility hint', () => {
    const source = readFileSync('apps/web/src/pages/event-types/EventTypeEditor.tsx', 'utf8')
    const start = source.indexOf(
      "me.organization.personal\n                    ? 'Anyone who knows",
    )
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf(',\n                )', start)
    expect(end).toBeGreaterThan(start)
    const expression = source.slice(start, end)
    function assertion(value: string) {
      const hint = copy<(me: typeof TEAM) => string>(
        `function hint(me) { return (${value}) }`,
        'hint',
        {},
      )
      expect(hint(TEAM)).not.toContain('can still book it')
    }
    assertion(expression)
    const mutant = mutate(expression, 'me.organization.personal', 'true')
    expect(() => assertion(mutant)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    assertion(expression)
  })

  it('detects an unconditional booking promise for an inactive unlisted team event', () => {
    function assertion(source: string) {
      const Share = share(source)
      const view = render(
        <MemoryRouter>
          <Share
            event={{ ...EVENT, isActive: false, isHidden: true }}
            me={TEAM}
            profile={null}
            schedules={[]}
            readiness={{ status: 'ready', item: CHECK }}
            retryReadiness={() => {}}
          />
        </MemoryRouter>,
      )
      try {
        expect(view.container.textContent).not.toContain('can still book it')
      } finally {
        view.unmount()
      }
    }
    assertion(shareFunction)
    const mutant = mutate(
      shareFunction,
      "team\n                  ? 'Unlisted is not access control.",
      "false\n                  ? 'Unlisted is not access control.",
    )
    expect(() => assertion(mutant)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    assertion(shareFunction)
  })

  it('detects replacing an activation-only next step with a configuration warning', () => {
    function assertion(source: string) {
      const Share = share(source)
      const view = render(
        <MemoryRouter>
          <Share
            event={{ ...EVENT, roundRobinActive: false }}
            me={TEAM}
            profile={null}
            schedules={[]}
            readiness={{
              status: 'ready',
              item: {
                ...CHECK,
                summary: 'needs_activation',
                activation: 'inactive',
                reasonCodes: ['activation_required'],
              },
            }}
            retryReadiness={() => {}}
          />
        </MemoryRouter>,
      )
      try {
        expect(screen.queryByText('Configuration needs attention')).toBeNull()
        expect(screen.getByRole('link', { name: 'Review round-robin activation' })).toBeDefined()
      } finally {
        view.unmount()
      }
    }
    assertion(shareFunction)
    const mutant = mutate(shareFunction, 'configurationNeedsReview &&', 'checksBlocked &&')
    expect(() => assertion(mutant)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    assertion(shareFunction)
  })

  it.each([
    { guard: 'e.isActive &&', event: { ...EVENT, isActive: false }, item: CHECK },
    { guard: 'e.roundRobinActive &&', event: { ...EVENT, roundRobinActive: false }, item: CHECK },
    {
      guard: 'teamReadinessAllowsSharing(item) &&',
      event: EVENT,
      item: { ...CHECK, summary: 'configuration_blocked' as const },
    },
  ])('detects removal of list $guard', ({ guard, event, item }) => {
    assertListHidden(tableSource, event, item)
    const mutant = mutate(tableSource, guard)
    expect(() => assertListHidden(mutant, event, item)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    assertListHidden(tableSource, event, item)
  })

  it.each([
    {
      guard: '!checksBlocked &&',
      event: EVENT,
      item: { ...CHECK, summary: 'check_failed' as const },
    },
    { guard: '    event.isActive &&', event: { ...EVENT, isActive: false }, item: CHECK },
    { guard: '!needsActivation', event: { ...EVENT, roundRobinActive: false }, item: CHECK },
  ])('detects removal of share $guard', ({ guard, event, item }) => {
    assertShareHidden(shareFunction, event, item)
    const mutant = mutate(shareFunction, guard, guard.endsWith('&&') ? '' : 'true')
    expect(() => assertShareHidden(mutant, event, item)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    assertShareHidden(shareFunction, event, item)
  })

  it.each(['api_key', 'member'] as const)(
    'detects an impossible unavailable-readiness retry for %s',
    (kind) => {
      function assertion(source: string) {
        const Share = share(source, kind === 'member' ? null : 'owner')
        const me =
          kind === 'api_key'
            ? { ...TEAM, principal: { kind: 'api_key' as const, apiKeyId: 'test-key' } }
            : TEAM
        const view = render(
          <MemoryRouter>
            <Share
              event={EVENT}
              me={me}
              profile={null}
              schedules={[]}
              readiness={{ status: 'unavailable' }}
              retryReadiness={() => {}}
            />
          </MemoryRouter>,
        )
        try {
          expect(screen.queryByRole('button', { name: 'Retry checks' })).toBeNull()
        } finally {
          view.unmount()
        }
      }
      assertion(shareFunction)
      const mutant = mutate(
        shareFunction,
        "(readiness.status !== 'unavailable' || canRetryUnavailable)",
        'true',
      )
      expect(() => assertion(mutant)).toThrowError(
        expect.objectContaining({ name: 'AssertionError' }),
      )
      assertion(shareFunction)
    },
  )

  const readinessSource = readFileSync('apps/web/src/pages/event-types/event-readiness.ts', 'utf8')
  const predicateSource = readinessSource.slice(
    readinessSource.indexOf('export function teamReadinessAllowsSharing'),
    readinessSource.indexOf('export function readinessErrorStatus'),
  )
  it.each([
    {
      before: "item.completeness === 'complete' &&",
      item: { ...CHECK, completeness: 'partial' as const },
    },
    {
      before: "(item.summary === 'checks_passed' || item.summary === 'partial_pool') &&",
      item: { ...CHECK, summary: 'configuration_blocked' as const },
    },
    {
      before:
        "!item.reasonCodes.some(\n      (reason) => reason === 'check_failed' || reason === 'check_not_performed',\n    )",
      item: { ...CHECK, reasonCodes: ['check_not_performed' as const] },
    },
  ])('detects service observation guard removal: $before', ({ before, item }) => {
    function assertion(source: string) {
      const predicate = copy<typeof teamReadinessAllowsSharing>(
        source,
        'teamReadinessAllowsSharing',
        {},
      )
      expect(predicate(item)).toBe(false)
      expect(predicate(CHECK)).toBe(true)
      expect(predicate({ ...CHECK, summary: 'partial_pool' })).toBe(true)
    }
    assertion(predicateSource)
    const mutant = mutate(predicateSource, before, before.endsWith('&&') ? '' : 'true')
    expect(() => assertion(mutant)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    assertion(predicateSource)
  })
})
