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
import { Field } from '../../components/forms.tsx'
import * as paths from '../../paths.ts'
import { ME } from '../../test/fake-api.tsx'
import { eventType } from '../../test/fixtures.ts'
import type { EditorReadiness } from './editor-readiness.ts'
import { type TeamEventReadiness, teamReadinessBlocksSharing } from './event-readiness.ts'
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
  teamReadinessBlocksSharing,
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
  it.each([
    {
      item: { ...CHECK, enablement: 'disabled' as const, summary: 'disabled' as const },
      shareGuard: " || item?.enablement === 'disabled'",
      previewGuard: " && previewItem?.enablement !== 'disabled'",
      preview: 'This event type is inactive. Enable it and save before sharing.',
      repair: 'Review enablement',
    },
    {
      item: { ...CHECK, activation: 'inactive' as const, summary: 'needs_activation' as const },
      shareGuard: " || item?.activation === 'inactive'",
      previewGuard: " && previewItem?.activation !== 'inactive'",
      preview: 'Activate round robin to get a public booking link.',
      repair: 'Review round-robin activation',
    },
  ])(
    'detects ignoring the observed $item.summary axis',
    ({ item, shareGuard, previewGuard, preview, repair }) => {
      function assertShare(source: string) {
        const Share = share(source)
        const view = render(
          <MemoryRouter>
            <Share
              event={EVENT}
              me={TEAM}
              profile={null}
              schedules={[]}
              readiness={{ status: 'ready', item }}
              retryReadiness={() => {}}
            />
          </MemoryRouter>,
        )
        try {
          expect(screen.queryByRole('button', { name: 'Copy booking link' })).toBeNull()
          expect(screen.queryByRole('link', { name: repair })).not.toBeNull()
          expect(screen.queryByText('Configuration not checked')).toBeNull()
        } finally {
          view.unmount()
        }
      }
      assertShare(shareFunction)
      expect(() => assertShare(mutate(shareFunction, shareGuard))).toThrowError(
        expect.objectContaining({ name: 'AssertionError' }),
      )
      assertShare(shareFunction)
      expect(() =>
        assertShare(mutate(shareFunction, "item?.completeness !== 'complete' ||", 'true ||')),
      ).toThrowError(expect.objectContaining({ name: 'AssertionError' }))
      assertShare(shareFunction)

      const editor = readFileSync('apps/web/src/pages/event-types/EventTypeEditor.tsx', 'utf8')
      const previewState = editor.slice(
        editor.indexOf('  const previewItem ='),
        editor.indexOf('  const duration ='),
      )
      const bookingPreview = editor.slice(
        editor.indexOf('function bookingLinkPreview('),
        editor.indexOf('/** A whole number of minutes'),
      )
      function assertPreview(source: string) {
        const Preview = copy<() => { slugPreview: string; previewReadinessMessage: string | null }>(
          `${bookingPreview}\nfunction Preview() { ${source}; return { slugPreview, previewReadinessMessage } }`,
          'Preview',
          {
            ...common,
            me: TEAM,
            profile: null,
            saved: EVENT,
            draft: { ...EVENT, hostUserIds: EVENT.hosts.map((host) => host.userId) },
            shareReadiness: { status: 'ready', item },
          },
        )
        expect(Preview()).toEqual({ slugPreview: preview, previewReadinessMessage: null })
      }
      assertPreview(previewState)
      expect(() => assertPreview(mutate(previewState, previewGuard))).toThrowError(
        expect.objectContaining({ name: 'AssertionError' }),
      )
      assertPreview(previewState)
    },
  )

  it.each([
    { status: 'unchecked' },
    { status: 'loading' },
    { status: 'error' },
    { status: 'unavailable' },
    { status: 'ready', item: undefined },
    { status: 'ready', item: { ...CHECK, completeness: 'partial' } },
    { status: 'ready', item: { ...CHECK, summary: 'check_failed' } },
    { status: 'ready', item: { ...CHECK, summary: 'not_checked' } },
  ] satisfies EditorReadiness[])(
    'detects removing saved links for unknown readiness: %j',
    (readiness) => {
      function assertion(source: string) {
        const Share = share(source)
        const view = render(
          <MemoryRouter>
            <Share
              event={EVENT}
              me={TEAM}
              profile={null}
              schedules={[]}
              readiness={readiness}
              retryReadiness={() => {}}
            />
          </MemoryRouter>,
        )
        try {
          expect(screen.queryByRole('button', { name: 'Copy booking link' })).not.toBeNull()
          expect(screen.queryByText('Configuration needs attention')).toBeNull()
        } finally {
          view.unmount()
        }
      }
      assertion(shareFunction)
      const mutant = mutate(
        shareFunction,
        'team && teamReadinessBlocksSharing(item)',
        "team && (item?.summary !== 'checks_passed' || item?.completeness !== 'complete')",
      )
      expect(() => assertion(mutant)).toThrowError(
        expect.objectContaining({ name: 'AssertionError' }),
      )
      assertion(shareFunction)
    },
  )

  it.each([
    { status: 'loading', message: 'Checking configuration…' },
    { status: 'error', message: 'Configuration check failed' },
    { status: 'unavailable', message: 'Readiness checks are unavailable for this account.' },
  ] as const)('detects false configuration warnings while $status', ({ status, message }) => {
    function assertion(source: string) {
      const Share = share(source)
      const view = render(
        <MemoryRouter>
          <Share
            event={EVENT}
            me={TEAM}
            profile={null}
            schedules={[]}
            readiness={{ status }}
            retryReadiness={() => {}}
          />
        </MemoryRouter>,
      )
      try {
        expect(screen.queryByText(message)).not.toBeNull()
        expect(screen.queryByText('Configuration needs attention')).toBeNull()
      } finally {
        view.unmount()
      }
    }
    assertion(shareFunction)
    const mutant = mutate(shareFunction, `'${message}'`, "'Configuration needs attention'")
    expect(() => assertion(mutant)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    assertion(shareFunction)
  })

  it('detects moving readiness status into the slug format hint', () => {
    const editor = readFileSync('apps/web/src/pages/event-types/EventTypeEditor.tsx', 'utf8')
    const fragment = editor.slice(
      editor.indexOf('<Field\n                id="slug"'),
      editor.indexOf('<Field\n                id="description"'),
    )
    function assertion(source: string) {
      const Preview = copy<ComponentType>(
        `function Preview() { return <>${source}</> }`,
        'Preview',
        {
          Field,
          t: (text: string) => text,
          ui: (text: string) => text,
          errors: {},
          draft: { slug: EVENT.slug },
          previewUrl: null,
          previewPath: '',
          slugPreview: 'Configuration check failed',
          previewReadinessMessage: 'Configuration check failed',
          saved: EVENT,
          dirty: false,
          setSlugTouched: () => {},
          set: () => {},
        },
      )
      const view = render(<Preview />)
      try {
        expect(view.container.querySelector('#slug-hint')?.textContent).toBe(
          'Lowercase letters, digits and hyphens. You can change this link.',
        )
        const status = view.container.querySelector('#booking-link-status')
        expect(status?.textContent).toContain('Configuration check failed')
        expect(view.container.querySelector('#slug-hint')?.contains(status)).toBe(false)
        expect(view.container.querySelector('#slug')?.getAttribute('aria-describedby')).toContain(
          'booking-link-status',
        )
      } finally {
        view.unmount()
      }
    }
    assertion(fragment)
    const mutant = mutate(
      fragment,
      "hint={t('Lowercase letters, digits and hyphens. You can change this link.')}",
      "hint={<>{t('Lowercase letters, digits and hyphens. You can change this link.')} {t(previewReadinessMessage)}</>}",
    )
    expect(() => assertion(mutant)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    assertion(fragment)
  })

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
    const mutant = mutate(shareFunction, 'configurationNeedsReview &&', 'true &&')
    expect(() => assertion(mutant)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    assertion(shareFunction)
  })

  it.each([
    { guard: 'e.isActive &&', event: { ...EVENT, isActive: false }, item: CHECK },
    { guard: 'e.roundRobinActive &&', event: { ...EVENT, roundRobinActive: false }, item: CHECK },
    {
      guard: '!teamReadinessBlocksSharing(item) &&',
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
      guard: '    !checksBlocked &&',
      event: EVENT,
      item: { ...CHECK, summary: 'configuration_blocked' as const },
    },
    { guard: '    !inactive &&', event: { ...EVENT, isActive: false }, item: CHECK },
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
  const blockingSource = readinessSource.slice(
    readinessSource.indexOf('export function teamReadinessBlocksSharing'),
    readinessSource.indexOf('export function readinessErrorStatus'),
  )
  it.each([
    {
      before: "item.summary === 'configuration_blocked' ||",
      after: '',
      item: { ...CHECK, summary: 'configuration_blocked' as const },
      blocked: true,
    },
    {
      before: "item.summary === 'dependency_unavailable' ||",
      after: '',
      item: { ...CHECK, summary: 'dependency_unavailable' as const },
      blocked: true,
    },
    ...(
      [
        'default_schedule_required',
        'host_configuration_required',
        'calendar_attention_required',
        'optional_feature_attention_required',
      ] as const
    ).map((reason) => ({
      before: `'${reason}',`,
      after: '',
      item: {
        ...CHECK,
        summary: 'check_failed' as const,
        completeness: 'partial' as const,
        reasonCodes: [reason],
      },
      blocked: true,
    })),
    {
      before: " || item.summary === 'partial_pool'",
      after: '',
      item: {
        ...CHECK,
        summary: 'partial_pool' as const,
        reasonCodes: ['default_schedule_required' as const],
      },
      blocked: false,
    },
  ])('detects known service result guard removal: $before', ({ before, after, item, blocked }) => {
    function assertion(source: string) {
      const blocks = copy<typeof teamReadinessBlocksSharing>(
        source,
        'teamReadinessBlocksSharing',
        {},
      )
      expect(blocks(item)).toBe(blocked)
      expect(blocks(undefined)).toBe(false)
      expect(blocks({ ...CHECK, summary: 'not_checked' })).toBe(false)
      expect(blocks({ ...CHECK, summary: 'check_failed' })).toBe(false)
      expect(blocks({ ...CHECK, completeness: 'partial' })).toBe(false)
    }
    assertion(blockingSource)
    const mutant = mutate(blockingSource, before, after)
    expect(() => assertion(mutant)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    assertion(blockingSource)
  })
})
