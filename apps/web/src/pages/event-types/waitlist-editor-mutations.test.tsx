import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as react from 'react'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n/admin.ts'
import { api, unwrap } from '../../api/client.ts'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { ConfirmAction } from '../../components/ConfirmAction.tsx'
import { FieldError, parseWhole, wholeNumberProblem } from '../../components/forms.tsx'
import { useLoad } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { literal, msg } from '../../i18n/translate.ts'
import { EVENT_TYPE, QUESTIONS, RULES } from '../../limits.ts'
import { fakeApi, json, ME } from '../../test/fake-api.tsx'
import { eventType } from '../../test/fixtures.ts'
import { isMultiLineText, isSingleLineText, singleLineProblem } from '../../text.ts'
import type * as eventFunctions from './event-type-form.ts'
import * as notificationFunctions from './notifications-form.ts'
import type { WaitlistEditor } from './WaitlistEditor.tsx'

const form = readFileSync('apps/web/src/pages/event-types/event-type-form.ts', 'utf8')
const editor = readFileSync('apps/web/src/pages/event-types/WaitlistEditor.tsx', 'utf8')
function copy<T>(source: string, exported: string, dependencies: Record<string, unknown>): T {
  const compiled = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import {readFileSync} from 'node:fs'; import {transformSync} from 'esbuild'; process.stdout.write(transformSync(readFileSync(0, 'utf8'), {loader:'tsx',format:'cjs',jsxFactory:'react.createElement',jsxFragment:'react.Fragment'}).code)",
    ],
    {
      input: source.replace(/^import[\s\S]*?from '[^']+'$/gm, '').replace(/^export /gm, ''),
      encoding: 'utf8',
    },
  )
  return new Function(...Object.keys(dependencies), `${compiled}; return ${exported}`)(
    ...Object.values(dependencies),
  ) as T
}
function mutate(source: string, before: string, after: string) {
  expect(source.split(before), 'mutation anchor matches once').toHaveLength(2)
  return source.replace(before, after)
}
const buildForm = (source: string) =>
  copy<typeof eventFunctions>(
    source,
    '{emptyDraft, draftFromEventType, toInput, toPatchInput, validateDraft}',
    {
      RequestError,
      parseWhole,
      wholeNumberProblem,
      literal,
      msg,
      EVENT_TYPE,
      QUESTIONS,
      RULES,
      isMultiLineText,
      isSingleLineText,
      singleLineProblem,
      ...notificationFunctions,
    },
  )
function detects(before: string, after: string, assertion: (source: string) => void) {
  assertion(form)
  expect(() => assertion(mutate(form, before, after))).toThrowError(
    expect.objectContaining({ name: 'AssertionError' }),
  )
  assertion(form)
}

const entryId = 'd0000000-0000-7000-8000-000000000001'
const path = '/api/v1/event-types/event-id/waitlist/entries'
const contact = 'grace@example.com'
const row = {
  id: entryId,
  state: 'active',
  email: contact,
  name: 'Grace',
  preferredWindow: {
    start: '2030-03-04T09:00:00.000Z',
    end: '2030-03-04T17:00:00.000Z',
    timeZone: 'Europe/Berlin',
  },
  createdAt: '2030-03-01T09:00:00.000Z',
  lastNotifiedAt: null,
}

function ImmediateAction({ onConfirm }: { onConfirm: () => Promise<void> }) {
  return (
    <button type="button" onClick={() => void onConfirm()}>
      Remove entry
    </button>
  )
}

async function assertEditor(
  source: string,
  assertion: (
    user: ReturnType<typeof userEvent.setup>,
    calls: ReturnType<typeof fakeApi>,
    saved: () => void,
  ) => Promise<void>,
  options: {
    personal?: boolean
    status?: string
    role?: string | null
    roles?: string[] | null
    reload?: () => void
    confirmReload?: () => void
    supported?: boolean
    removeStatus?: number
    removeCode?: string
  } = {},
) {
  const calls = fakeApi({
    [`GET ${path}`]: () => json(200, { data: [row], nextAfter: null }),
    [`DELETE ${path}/${entryId}`]: () =>
      json(
        options.removeStatus ?? 200,
        options.removeStatus ? { error: options.removeCode ?? 'forbidden' } : { removed: true },
      ),
  })
  const management = {
    status: options.status ?? 'ready',
    role: options.role ?? null,
    roles: options.roles === undefined ? ['member'] : options.roles,
    revoke: vi.fn(),
    reload: options.reload ?? vi.fn(),
  }
  const Component = copy<typeof WaitlistEditor>(source, 'WaitlistEditor', {
    react,
    useState: react.useState,
    useCallback: react.useCallback,
    api,
    unwrap,
    isOrganizationContextChanged,
    RequestError,
    ConfirmAction,
    FieldError,
    useLoad,
    useI18n,
    useMe: () => ({
      ...ME,
      organization: { ...ME.organization, personal: options.personal ?? true },
    }),
    useSession: () => ({ confirmReload: options.confirmReload ?? vi.fn() }),
    useTeamManagementAccess: () => management,
    ImmediateAction,
  })
  const view = render(
    <Component
      enabled={false}
      supported={options.supported ?? true}
      eventTypeId="event-id"
      errors={{}}
      disabled={false}
      onChange={vi.fn()}
    />,
  )
  try {
    await assertion(userEvent.setup(), calls, () =>
      view.rerender(
        <Component
          enabled={false}
          supported={options.supported ?? true}
          eventTypeId="event-id"
          savedVersion={1}
          errors={{}}
          disabled={false}
          onChange={vi.fn()}
        />,
      ),
    )
  } finally {
    view.unmount()
  }
}
async function detectsEditor(
  before: string,
  after: string,
  assertion: Parameters<typeof assertEditor>[1],
  options?: Parameters<typeof assertEditor>[2],
) {
  await assertEditor(editor, assertion, options)
  await expect(
    assertEditor(mutate(editor, before, after), assertion, options),
  ).rejects.toMatchObject({ name: 'AssertionError' })
  await assertEditor(editor, assertion, options)
}
async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'View waitlist entries' }))
  await screen.findByText(contact)
}

describe('waitlist editor production-source mutation controls', () => {
  it('detects retaining a stale contact list after saving new event settings', async () => {
    await detectsEditor(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal production source mutation
      'key={`${eventTypeId}:${savedVersion}`}',
      'key={eventTypeId}',
      async (user, _calls, saved) => {
        await open(user)
        saved()
        expect(screen.queryByText(contact)).toBeNull()
        await screen.findByText(contact)
      },
    )
  })
  it('detects enabling new event types by default', () => {
    detects('waitlistEnabled: false,', 'waitlistEnabled: true,', (source) =>
      expect(buildForm(source).emptyDraft().waitlistEnabled).toBe(false),
    )
  })
  it('detects replacing concurrent settings on metadata saves', () => {
    detects(
      'delete body.waitlist',
      'body.waitlist = { enabled: draft.waitlistEnabled }',
      (source) => {
        const form = buildForm(source)
        for (const enabled of [false, true]) {
          const baseline = form.draftFromEventType(eventType({ waitlist: { enabled } }))
          expect(form.toPatchInput({ ...baseline, title: 'Renamed' }, baseline)).not.toHaveProperty(
            'waitlist',
          )
        }
      },
    )
  })
  it('detects dropping explicit disable settings', () => {
    detects(
      'else body.waitlist = { enabled: draft.waitlistEnabled }',
      'else delete body.waitlist',
      (source) => {
        const form = buildForm(source)
        const baseline = { ...form.emptyDraft(), waitlistEnabled: true }
        expect(form.toPatchInput({ ...baseline, waitlistEnabled: false }, baseline)).toHaveProperty(
          'waitlist',
          { enabled: false },
        )
      },
    )
  })
  it('detects accepting newly enabled unsupported modes', () => {
    detects(
      "(draft.schedulingType !== 'individual' || draft.hostUserIds.length > 1)",
      'false',
      (source) => {
        const form = buildForm(source)
        expect(
          form.validateDraft({
            ...form.emptyDraft(),
            title: 'Test',
            slug: 'test',
            schedulingType: 'round_robin',
            hostUserIds: [ME.user.id],
            waitlistEnabled: true,
          }),
        ).toHaveProperty('waitlist')
      },
    )
  })
  it('detects exposing list actions to ordinary team members', async () => {
    await detectsEditor(
      "me.organization.personal || (access.status === 'ready' && access.role !== null)",
      'true',
      async (_user, calls) => {
        expect(screen.queryByRole('button', { name: 'View waitlist entries' })).toBeNull()
        expect(screen.queryByRole('checkbox')).toBeNull()
        expect(calls.to(`GET ${path}`)).toHaveLength(0)
      },
      { personal: false },
    )
  })
  it('detects treating unknown management access as confirmed lack of permission', async () => {
    await detectsEditor(
      "access.status === 'error' ||",
      'false ||',
      async () => {
        expect(
          screen.queryByText('Could not check waitlist management access. Try again.'),
        ).not.toBeNull()
        expect(
          screen.queryByText('Only team owners and admins can manage the waitlist.'),
        ).toBeNull()
      },
      { personal: false, status: 'error' },
    )
  })
  it('detects presenting revoked team access with unknown roles as a confirmed member role', async () => {
    await detectsEditor(
      'access.roles === null',
      'false',
      async () => {
        expect(
          screen.queryByText('Could not check waitlist management access. Try again.'),
        ).not.toBeNull()
        expect(
          screen.queryByText('Only team owners and admins can manage the waitlist.'),
        ).toBeNull()
        expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeNull()
      },
      { personal: false, roles: null },
    )
  })
  it('detects retrying revoked team access without resetting the session provider', async () => {
    const reload = vi.fn()
    const confirmReload = vi.fn()
    await detectsEditor(
      "onClick={access.status === 'error' ? access.reload : confirmReload}",
      'onClick={access.reload}',
      async (user) => {
        reload.mockClear()
        confirmReload.mockClear()
        await user.click(screen.getByRole('button', { name: 'Try again' }))
        expect(confirmReload).toHaveBeenCalledTimes(1)
        expect(reload).not.toHaveBeenCalled()
      },
      { personal: false, roles: null, reload, confirmReload },
    )
  })
  it('detects describing unchecked management access as an account limitation', async () => {
    await detectsEditor(
      "'Checking waitlist management access…'",
      "'Waitlist management is unavailable for this account.'",
      async () => {
        expect(screen.queryByText('Checking waitlist management access…')).not.toBeNull()
        expect(
          screen.queryByText('Waitlist management is unavailable for this account.'),
        ).toBeNull()
      },
      { personal: false, status: 'loading' },
    )
  })
  it('detects suggesting that an active entry was notified at an unknown time', async () => {
    await detectsEditor(
      "entry.state === 'pending_verification' || entry.state === 'active'",
      'false',
      async (user) => {
        await open(user)
        expect(screen.queryByText('Not notified yet')).not.toBeNull()
        expect(screen.queryByText('Notification time unavailable')).toBeNull()
      },
    )
  })
  it('detects enabling an unsupported type through the switch', async () => {
    await detectsEditor(
      'disabled || (!supported && !enabled)',
      'disabled',
      async () => {
        expect(screen.getByRole<HTMLInputElement>('checkbox').disabled).toBe(true)
      },
      { supported: false },
    )
  })
  it('detects removing an entry without confirmation', async () => {
    await detectsEditor('<ConfirmAction', '<ImmediateAction', async (user, calls) => {
      await open(user)
      await user.click(screen.getByRole('button', { name: 'Remove entry' }))
      expect(calls.to(`DELETE ${path}/${entryId}`)).toHaveLength(0)
    })
  })
  it('detects retaining contact details after successful removal', async () => {
    await detectsEditor(
      'const erased = removed.includes(entry.id)',
      'const erased = false',
      async (user) => {
        await open(user)
        await user.click(screen.getByRole('button', { name: 'Remove entry' }))
        await user.click(screen.getByRole('button', { name: 'Remove entry' }))
        await waitFor(() => expect(screen.queryByText(contact)).toBeNull())
        expect(screen.queryByText('Grace')).toBeNull()
        expect(screen.queryByText(/Europe\/Berlin/)).toBeNull()
      },
    )
  })
  it('detects retaining readable contacts after a remove permission refusal', async () => {
    await detectsEditor(
      '        setRevoked(true)\n        access.revoke()',
      '        setRevoked(false)\n        access.revoke()',
      async (user) => {
        await open(user)
        await user.click(screen.getByRole('button', { name: 'Remove entry' }))
        await user.click(screen.getByRole('button', { name: 'Remove entry' }))
        await waitFor(() => expect(screen.queryByText(contact)).toBeNull())
      },
      { removeStatus: 403 },
    )
  })
  it('detects presenting a refused entry request as an account limitation', async () => {
    await detectsEditor(
      '<p role="status">{t(\'Could not check waitlist management access. Try again.\')}</p>',
      '<p role="status">{t(\'Waitlist management is unavailable for this account.\')}</p>',
      async (user) => {
        await open(user)
        await user.click(screen.getByRole('button', { name: 'Remove entry' }))
        await user.click(screen.getByRole('button', { name: 'Remove entry' }))
        await waitFor(() =>
          expect(
            screen.queryByText('Could not check waitlist management access. Try again.'),
          ).not.toBeNull(),
        )
        expect(
          screen.queryByText('Waitlist management is unavailable for this account.'),
        ).toBeNull()
      },
      { removeStatus: 403 },
    )
  })
  it('detects omitting the editor organization from removal', async () => {
    await detectsEditor(
      "          params: { path: { id: eventTypeId, entryId } },\n          headers: { 'X-Expected-Organization-Id': expectedOrganizationId },",
      '          params: { path: { id: eventTypeId, entryId } },',
      async (user, calls) => {
        await open(user)
        await user.click(screen.getByRole('button', { name: 'Remove entry' }))
        await user.click(screen.getByRole('button', { name: 'Remove entry' }))
        expect(
          calls.to(`DELETE ${path}/${entryId}`)[0]?.headers.get('X-Expected-Organization-Id'),
        ).toBe(ME.organization.id)
      },
    )
  })
})
