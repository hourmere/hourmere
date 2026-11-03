import '../../i18n/admin.ts'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isPublicTeamSlug } from '@hourmere/core/reserved'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as react from 'react'
import { type ComponentType, useEffect, useRef } from 'react'
import { Link, MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventType } from '../../api/resources.ts'
import { CopyButton } from '../../components/CopyButton.tsx'
import * as paths from '../../paths.ts'
import { fakeApi, json, ME } from '../../test/fake-api.tsx'
import { eventType } from '../../test/fixtures.ts'
import { EventEmbedAction } from './EventEmbedAction.tsx'
import { type TeamEventReadiness, teamReadinessBlocksSharing } from './event-readiness.ts'
import type { SavedEventShare } from './SavedEventShare.tsx'

const TEAM = { ...ME, organization: { ...ME.organization, personal: false, slug: 'design-team' } }
// A newer readiness observation must override the stale active event snapshot.
const EVENT = eventType({ ownerUserId: null, isActive: true })
const CHECK: TeamEventReadiness = {
  eventTypeId: EVENT.id,
  enablement: 'disabled',
  activation: 'not_applicable',
  summary: 'disabled',
  completeness: 'complete',
  evaluatedAt: '2026-11-02T12:00:00.000Z',
  reasonCodes: [],
  fixKinds: [],
}
const INACTIVE = 'This event type is inactive. Enable it and save before generating embed code.'
const sources = {
  editor: readFileSync('apps/web/src/pages/event-types/SavedEventShare.tsx', 'utf8'),
  row: readFileSync('apps/web/src/pages/event-types/EventTypes.tsx', 'utf8'),
}
const ConfigurationChecks = () => null

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    }),
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: vi.fn(),
  })
  fakeApi({
    'GET /api/v1/instance/embed': () =>
      json(200, { publicUrl: 'https://schedule.example.test', embedAllowedOrigins: [] }),
  })
})

/** Exercise real entrypoint source and the real dialog without replacing production files. */
function copy<T>(source: string, exported: string): T {
  const compiled = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { readFileSync } from 'node:fs'; import { transformSync } from 'esbuild'; process.stdout.write(transformSync(readFileSync(0, 'utf8'), { loader: 'tsx', format: 'cjs', jsxFactory: 'reactRuntime.createElement', jsxFragment: 'reactRuntime.Fragment' }).code)",
    ],
    { input: source.replace(/^export /gm, ''), encoding: 'utf8' },
  )
  const dependencies = {
    ...paths,
    EventEmbedAction,
    Link,
    CopyButton,
    isPublicTeamSlug,
    useEffect,
    useRef,
    useI18n: () => ({ t: (text: string) => text, locale: 'en' }),
    useTeamManagementAccess: () => ({ status: 'ready', role: 'owner' }),
    teamReadinessBlocksSharing,
    useEventReadiness: () => [{ status: 'ready', data: new Map([[EVENT.id, CHECK]]) }, () => {}],
    formatMinutes: () => '30 min',
    ConfigurationChecks,
  }
  return new Function(
    'reactRuntime',
    ...Object.keys(dependencies),
    `${compiled}; return ${exported}`,
  )(react, ...Object.values(dependencies)) as T
}

async function assertDisabled(source: string, entry: 'editor' | 'row') {
  const Share =
    entry === 'editor'
      ? copy<typeof SavedEventShare>(
          source.slice(source.indexOf('export function SavedEventShare(')),
          'SavedEventShare',
        )
      : null
  const Table =
    entry === 'row'
      ? copy<ComponentType<{ eventTypes: EventType[]; me: typeof TEAM; profile: null }>>(
          source.slice(source.indexOf('function EventTypeTable(')),
          'EventTypeTable',
        )
      : null
  const view = render(
    <MemoryRouter>
      {Share && (
        <Share
          event={EVENT}
          me={TEAM}
          profile={null}
          schedules={[]}
          readiness={{ status: 'ready', item: CHECK }}
          retryReadiness={() => {}}
        />
      )}
      {Table && <Table eventTypes={[EVENT]} me={TEAM} profile={null} />}
    </MemoryRouter>,
  )
  try {
    const user = userEvent.setup()
    if (entry === 'row') {
      await user.click(screen.getByRole('button', { name: /More actions/ }))
      await user.click(screen.getByRole('menuitem', { name: 'Embed' }))
    } else {
      await user.click(screen.getByRole('button', { name: 'Embed' }))
    }
    await screen.findByText('Embedding is disabled.', { exact: false })
    expect(screen.queryByText(INACTIVE)).not.toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Embed code' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy embed code' })).toBeNull()
  } finally {
    view.unmount()
  }
}

describe('readiness-derived embed enablement at the entrypoints', () => {
  it.each(['editor', 'row'] as const)(
    'explains inactivity and withholds code for a stale active event in the %s',
    async (entry) => {
      await assertDisabled(sources[entry], entry)
    },
  )

  it.each([
    {
      entry: 'editor',
      before: 'event={{ ...event, isActive: !inactive }}',
      after: 'event={event}',
    },
    { entry: 'row', before: 'event={{ ...e, isActive }}', after: 'event={e}' },
  ] as const)(
    'detects passing stale raw enablement from the $entry to the dialog',
    async ({ entry, before, after }) => {
      const source = sources[entry]
      expect(source.split(before), 'mutation must match once').toHaveLength(2)
      await assertDisabled(source, entry)
      await expect(assertDisabled(source.replace(before, after), entry)).rejects.toMatchObject({
        name: 'AssertionError',
      })
      await assertDisabled(source, entry)
    },
  )
})
