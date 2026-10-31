import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isPublicTeamSlug } from '@hourmere/core/reserved'
import { render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'
import * as react from 'react'
import { Link, MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { CopyButton } from '../../components/CopyButton.tsx'
import * as paths from '../../paths.ts'
import { ME } from '../../test/fake-api.tsx'
import { eventType } from '../../test/fixtures.ts'
import { validDefault } from '../availability/valid-default.ts'
import { type TeamEventReadiness, teamReadinessBlocksSharing } from './event-readiness.ts'

const TEAM = { ...ME, organization: { ...ME.organization, personal: false, slug: 'Design-TEAM' } }
const EVENT = eventType({
  ownerUserId: null,
  schedulingType: 'round_robin',
  roundRobinActive: true,
})
const source = readFileSync('apps/web/src/pages/event-types/EventTypes.tsx', 'utf8')
const tableSource = source.slice(source.indexOf('function EventTypeTable('))
const pageSource = source.slice(
  source.indexOf('export function EventTypesPage()'),
  source.indexOf('function EventTypeTable('),
)

function copy(code: string, exported: string, dependencies: Record<string, unknown>) {
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
    ...Object.keys(dependencies),
    `${compiled}; return ${exported}`,
  )(react, ...Object.values(dependencies)) as ComponentType
}

const EmptyComponent = () => null

const common = {
  ...paths,
  Link,
  CopyButton,
  isPublicTeamSlug,
  teamReadinessBlocksSharing,
  useI18n: () => ({ t: (text: string) => text, uiText: (text: string) => text, locale: 'en' }),
}

function mutate(code: string, before: string, after: string) {
  expect(code.split(before)).toHaveLength(2)
  return code.replace(before, after)
}

function assertTable(
  code: string,
  status: 'loading' | 'error' | 'unavailable' | 'ready',
  neutral = false,
  item?: TeamEventReadiness,
  hidden = false,
) {
  const Table = copy(code, 'EventTypeTable', {
    ...common,
    useEventReadiness: () => [{ status, data: new Map(item ? [[EVENT.id, item]] : []) }, () => {}],
    ConfigurationChecks: EmptyComponent,
    formatMinutes: () => '30 min',
  }) as ComponentType<{ eventTypes: (typeof EVENT)[]; me: typeof TEAM; profile: null }>
  const view = render(
    <MemoryRouter>
      <Table eventTypes={[EVENT]} me={TEAM} profile={null} />
    </MemoryRouter>,
  )
  try {
    if (hidden) {
      expect(screen.queryByRole('button', { name: 'Copy link for {0}' })).toBeNull()
      expect(view.container.querySelector('a[href*="/team/Design-TEAM/"]')).toBeNull()
    } else {
      expect(screen.queryByRole('button', { name: 'Copy link for {0}' })).not.toBeNull()
      expect(view.container.querySelector('a[href*="/team/Design-TEAM/"]')).not.toBeNull()
      expect(screen.queryByText('No public booking link')).toBeNull()
    }
    if (neutral) {
      expect(
        screen.queryByText('Readiness checks are unavailable for this account.'),
      ).not.toBeNull()
      expect(screen.queryByText('Configuration needs attention')).toBeNull()
    }
  } finally {
    view.unmount()
  }
}

function assertHours(code: string) {
  const Page = copy(code, 'EventTypesPage', {
    ...common,
    validDefault,
    useMe: () => TEAM,
    usePageTitle: () => {},
    useSearchParams: () => [new URLSearchParams()],
    useFlash: () => '',
    useState: react.useState,
    loadPage: () => {},
    useEventTypesLoad: () => [
      { status: 'ready', data: { eventTypes: [], schedules: [], profile: null } },
      () => {},
      null,
    ],
    PageHeader: EmptyComponent,
    EmptyState: EmptyComponent,
    PersonalSetupGuide: EmptyComponent,
    EventTypeTable: EmptyComponent,
  })
  const view = render(
    <MemoryRouter>
      <Page />
    </MemoryRouter>,
  )
  try {
    expect(
      screen.queryByRole('link', { name: 'Set your weekly hours' })?.getAttribute('href'),
    ).toBe('/app/availability/new')
  } finally {
    view.unmount()
  }
}

describe('team list review regression source-copy controls', () => {
  it.each(['loading', 'error', 'unavailable', 'ready'] as const)(
    'detects treating %s readiness as a reason to remove the link',
    (status) => {
      assertTable(tableSource, status)
      const mutant = mutate(
        tableSource,
        '!teamReadinessBlocksSharing(item) &&',
        "item?.summary === 'checks_passed' &&",
      )
      expect(() => assertTable(mutant, status)).toThrowError(
        expect.objectContaining({ name: 'AssertionError' }),
      )
      assertTable(tableSource, status)
    },
  )

  it.each([
    { axis: 'enablement', value: 'disabled', guard: "item?.enablement !== 'disabled'" },
    { axis: 'activation', value: 'inactive', guard: "item?.activation !== 'inactive'" },
  ] as const)(
    'detects ignoring the known readiness $axis with an older active event',
    ({ axis, value, guard }) => {
      const item: TeamEventReadiness = {
        eventTypeId: EVENT.id,
        enablement: 'enabled',
        activation: 'active',
        summary: 'checks_passed',
        completeness: 'complete',
        evaluatedAt: '2026-10-31T12:00:00.000Z',
        reasonCodes: [],
        fixKinds: [],
        [axis]: value,
      }
      assertTable(tableSource, 'ready', false, item, true)
      const mutant = mutate(tableSource, guard, 'true')
      expect(() => assertTable(mutant, 'ready', false, item, true)).toThrowError(
        expect.objectContaining({ name: 'AssertionError' }),
      )
      assertTable(tableSource, 'ready', false, item, true)
    },
  )

  it('detects calling unavailable readiness a configuration problem', () => {
    assertTable(tableSource, 'unavailable', true)
    const mutant = mutate(
      tableSource,
      "t('Readiness checks are unavailable for this account.')",
      "t('Configuration needs attention')",
    )
    expect(() => assertTable(mutant, 'unavailable', true)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    assertTable(tableSource, 'unavailable', true)
  })

  it('detects removing the team weekly-hours guidance', () => {
    assertHours(pageSource)
    const mutant = mutate(
      pageSource,
      '!me.organization.personal && !state.data.schedules.some(validDefault)',
      'false',
    )
    expect(() => assertHours(mutant)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    assertHours(pageSource)
  })
})
