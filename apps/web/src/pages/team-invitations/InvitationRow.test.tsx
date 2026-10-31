import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as react from 'react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import * as auth from '../../api/auth.ts'
import type { Schemas } from '../../api/client.ts'
import * as client from '../../api/client.ts'
import * as errors from '../../api/errors.ts'
import * as breakable from '../../components/BreakableText.tsx'
import * as conflict from '../../components/OrganizationContextConflict.tsx'
import * as format from '../../format.ts'
import * as runtime from '../../i18n/runtime.tsx'
import { InterfaceScope } from '../../i18n/runtime.tsx'
import { chooseLanguage } from '../../i18n/store.ts'
import * as translate from '../../i18n/translate.ts'
import { fakeApi, json, later } from '../../test/fake-api.tsx'
import * as unsavedChanges from '../../unsaved-changes.tsx'
import { UnsavedChangesProvider } from '../../unsaved-changes.tsx'
import { TeamInvitations } from '../TeamInvitations.tsx'
import { InvitationRow } from './InvitationRow.tsx'

const ORGANIZATION_ID = '00000000-0000-7000-8000-000000000010'
const INVITATION: Schemas['TeamInvitationSummary'] = {
  id: '00000000-0000-7000-8000-000000000020',
  email: 'recipient@example.com',
  status: 'pending',
  createdAt: '2026-10-30T10:00:00.000Z',
  expiresAt: '2026-11-13T10:00:00.000Z',
  generation: 1,
  resendAllowed: true,
  resendDeniedReason: null,
  resendRetryAfterSeconds: null,
  invalidReason: null,
  delivery: {
    state: 'smtp_accepted',
    attempts: 1,
    lastAttemptAt: '2026-10-30T10:00:00.000Z',
    lastErrorCode: null,
  },
}
const READ = `GET /api/v1/team/invitations/${INVITATION.id}`
const NEW_INVITATION_ID = '00000000-0000-7000-8000-000000000021'
const NEW_READ = `GET /api/v1/team/invitations/${NEW_INVITATION_ID}`
const CANCEL = `POST /api/v1/team/invitations/${INVITATION.id}/cancel`
const RESEND = 'POST /api/auth/organization/invite-member'
const LIST = 'GET /api/v1/team/invitations'
function queued(invitation = INVITATION, generation = 2) {
  return json(200, {
    ...invitation,
    existing: true,
    organizationId: ORGANIZATION_ID,
    inviterId: 'actor',
    role: 'member',
    delivery: { generation, state: 'queued', attempts: 0 },
  })
}
function display(invitation = INVITATION, Row = InvitationRow) {
  function ObservedRow() {
    const [current, setCurrent] = useState(invitation)
    return (
      <ul>
        <Row invitation={current} organizationId={ORGANIZATION_ID} onObserved={setCurrent} />
      </ul>
    )
  }
  return render(
    <InterfaceScope surface="admin">
      <ObservedRow />
    </InterfaceScope>,
  )
}

describe('invitation recovery', () => {
  it.each([
    ['en', 'Resend invitation', 'Cancel invitation', 'Try again in 43 seconds.'],
    ['zh-CN', '重新发送邀请', '取消邀请', '请在 43 秒后重试。'],
  ] as const)(
    'shows every existing invitation action and the server cooldown in %s',
    async (language, resend, cancel, cooldown) => {
      chooseLanguage(language)
      let checked = false
      const api = fakeApi({
        [READ]: () => {
          checked = true
          return json(200, INVITATION)
        },
      })
      display({
        ...INVITATION,
        resendAllowed: false,
        resendDeniedReason: 'INVITATION_RESEND_COOLDOWN',
        resendRetryAfterSeconds: 43,
      })
      expect((screen.getByRole('button', { name: resend }) as HTMLButtonElement).disabled).toBe(
        true,
      )
      expect(screen.getByText(cooldown, { exact: false })).toBeDefined()
      expect(screen.getByRole('button', { name: cancel })).toBeDefined()
      await userEvent.click(
        screen.getByRole('button', {
          name: language === 'en' ? 'Check invitation status' : '检查邀请状态',
        }),
      )
      await waitFor(() =>
        expect((screen.getByRole('button', { name: resend }) as HTMLButtonElement).disabled).toBe(
          false,
        ),
      )
      expect(checked).toBe(true)
      expect(api.to(READ)[0]?.headers.get('X-Expected-Organization-Id')).toBe(ORGANIZATION_ID)
    },
  )

  it.each([
    ['INVITATION_DELIVERY_BUSY', 'Invitation delivery is in progress. Try again shortly.'],
    ['INVITATION_GENERATION_LIMIT', 'This invitation has reached its resend limit.'],
    ['INVITATION_RECIPIENT_ALREADY_MEMBER', 'This address already belongs to a team member.'],
    ['INVITATION_RATE_LIMITED', 'Invitation requests are temporarily limited. Try again later.'],
    [
      'INVITATION_PENDING_LIMIT',
      'This team has reached its pending invitation limit. Resolve pending invitations before inviting more people.',
    ],
    [
      'INVITATION_CONFLICT',
      'A newer invitation exists for this address. Review the pending invitations.',
    ],
    ['TEAM_MANAGEMENT_ACCESS_DENIED', 'You do not have permission to manage invitations.'],
    ['INVITATION_INELIGIBLE', 'This invitation is no longer available for resending.'],
  ] as const)(
    'explains the server denial %s without guessing send eligibility',
    (reason, message) => {
      display({ ...INVITATION, resendAllowed: false, resendDeniedReason: reason })
      const button = screen.getByRole('button', { name: 'Resend invitation' }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      expect(
        document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent,
      ).toContain(message)
    },
  )

  it('keeps keyboard confirmation reversible and shows joined when acceptance wins cancellation', async () => {
    const cancel = later()
    const joined = {
      ...INVITATION,
      status: 'accepted',
      resendAllowed: false,
      resendDeniedReason: 'INVITATION_INELIGIBLE',
    }
    const api = fakeApi({ [CANCEL]: () => cancel.response, [READ]: () => json(200, joined) })
    display()
    const user = userEvent.setup()
    const start = screen.getByRole('button', { name: 'Cancel invitation' })
    await user.click(start)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep invitation' }))
    expect(
      screen.getByText(
        'Cancelling only voids this invitation. It never removes a member who has already joined.',
      ),
    ).toBeDefined()
    await user.keyboard('{Escape}')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel invitation' }))
    await user.keyboard('{Enter}')
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Confirm cancellation' }),
    )
    await user.keyboard('{Enter}{Enter}')
    await waitFor(() => expect(api.to(CANCEL)).toHaveLength(1))
    expect(screen.getByRole('heading', { name: `Invitation to ${INVITATION.email}` })).toBeDefined()
    expect(screen.getByText('Pending')).toBeDefined()
    await cancel.answer(json(200, joined))
    await screen.findByText('Joined')
    const notice = screen.getByText('The recipient has joined. Their membership was not changed.')
    expect(document.activeElement).toBe(notice.parentElement)
    expect(screen.queryByRole('button', { name: 'Cancel invitation' })).toBeNull()
    expect(api.to(CANCEL)[0]?.body).toEqual({})
    expect(api.to(CANCEL)[0]?.headers.get('X-Expected-Organization-Id')).toBe(ORGANIZATION_ID)
    expect(api.to(READ)).toHaveLength(1)
  })

  it('reports cancellation while a send remains in progress without claiming mail was recalled', async () => {
    const current = {
      ...INVITATION,
      status: 'canceled',
      resendAllowed: false,
      delivery: { ...INVITATION.delivery, state: 'sending' },
    }
    fakeApi({ [CANCEL]: () => json(200, current), [READ]: () => json(200, current) })
    display({
      ...INVITATION,
      resendAllowed: false,
      resendDeniedReason: 'INVITATION_DELIVERY_BUSY',
      delivery: { ...INVITATION.delivery, state: 'sending' },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Cancel invitation' }))
    await userEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }))
    await screen.findByText('Cancelled')
    expect(screen.getByText('Submitting to the mail server')).toBeDefined()
    expect(
      screen.getByText(
        'An email already being sent may still arrive. This invitation can no longer be used.',
      ),
    ).toBeDefined()
  })

  it('shows the final cancelled state when cancellation overtakes an accepted resend', async () => {
    const response = later()
    const api = fakeApi({
      [RESEND]: () => response.response,
      [READ]: () => json(200, { ...INVITATION, status: 'canceled', resendAllowed: false }),
    })
    display()
    await userEvent.click(screen.getByRole('button', { name: 'Resend invitation' }))
    expect(screen.getByRole('heading', { name: `Invitation to ${INVITATION.email}` })).toBeDefined()
    await response.answer(queued())
    await screen.findByText('Invitation cancelled. Its link can no longer be used.')
    expect(screen.queryByText('Invitation queued for delivery.')).toBeNull()
    expect(api.to(RESEND)).toHaveLength(1)
    expect(api.to(READ)).toHaveLength(1)
  })

  it('reads the final lifecycle after a stale resend refusal', async () => {
    fakeApi({
      [RESEND]: () => json(409, { code: 'INVITATION_INELIGIBLE' }),
      [READ]: () => json(200, { ...INVITATION, status: 'accepted', resendAllowed: false }),
    })
    display()
    await userEvent.click(screen.getByRole('button', { name: 'Resend invitation' }))
    await screen.findByText('Joined')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('blocks further mutations after an uncertain response until a read succeeds', async () => {
    let reads = 0
    const api = fakeApi({
      [CANCEL]: () => {
        throw new TypeError('network unavailable')
      },
      [READ]: () =>
        ++reads === 1
          ? json(503, {})
          : json(200, { ...INVITATION, status: 'canceled', resendAllowed: false }),
    })
    display()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel invitation' }))
    await userEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }))
    await screen.findByText(
      'Could not confirm the invitation status. Check its status before trying another action.',
    )
    expect(
      (screen.getByRole('button', { name: 'Resend invitation' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Confirm cancellation' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Check invitation status' }))
    await screen.findByText('Cancelled')
    expect(api.to(CANCEL)).toHaveLength(1)
  })

  it('follows queued to SMTP acceptance to joined after the invitation leaves the pending filter', async () => {
    let lists = 0
    let details = 0
    const waiting = {
      ...INVITATION,
      delivery: { ...INVITATION.delivery, state: 'queued' as const },
    }
    const joined = { ...INVITATION, status: 'accepted', resendAllowed: false }
    const api = fakeApi({
      [LIST]: () =>
        json(200, {
          data: ++lists === 1 ? [waiting] : lists === 2 ? [INVITATION] : [],
          nextCursor: null,
        }),
      [READ]: () => json(200, ++details === 1 ? waiting : details === 2 ? INVITATION : joined),
    })
    render(
      <InterfaceScope surface="admin">
        <UnsavedChangesProvider>
          <TeamInvitations organizationId={ORGANIZATION_ID} />
        </UnsavedChangesProvider>
      </InterfaceScope>,
    )
    await screen.findByText('Waiting to send')
    await userEvent.click(screen.getByRole('button', { name: 'Check invitation status' }))
    await screen.findByText('Accepted by the mail server')
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Check invitation status' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Check invitation status' }))
    await screen.findByText('Joined')
    expect(
      screen.getByText('The recipient has joined. Their membership was not changed.'),
    ).toBeDefined()
    expect(screen.queryByText('Invitation queued for delivery.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel invitation' })).toBeNull()
    expect(api.to(READ)).toHaveLength(3)
    expect(api.to(LIST)).toHaveLength(3)
  })

  it.each(['en', 'zh-CN'] as const)(
    'follows a new invitation ID after replacing an expired invitation in %s',
    async (language) => {
      chooseLanguage(language)
      let current: Schemas['TeamInvitationSummary'] = { ...INVITATION, status: 'expired' }
      const api = fakeApi({
        [LIST]: ({ path }) => {
          const status = new URL(path, location.origin).searchParams.get('status')
          return json(200, { data: status === current.status ? [current] : [], nextCursor: null })
        },
        [READ]: () => json(200, { ...INVITATION, status: 'canceled', resendAllowed: false }),
        [NEW_READ]: () => json(200, current),
        [RESEND]: () => {
          current = {
            ...INVITATION,
            id: NEW_INVITATION_ID,
            generation: 1,
            resendAllowed: false,
            delivery: { ...INVITATION.delivery, state: 'queued' },
          }
          return queued(current, 1)
        },
      })
      render(
        <InterfaceScope surface="admin">
          <UnsavedChangesProvider>
            <TeamInvitations organizationId={ORGANIZATION_ID} />
          </UnsavedChangesProvider>
        </InterfaceScope>,
      )
      await screen.findByText(
        language === 'en' ? 'No pending invitations on this page.' : '本页没有待接受的邀请。',
      )
      await userEvent.selectOptions(
        screen.getByRole('combobox', {
          name: language === 'en' ? 'Filter invitations' : '筛选邀请',
        }),
        'expired',
      )
      await userEvent.click(
        await screen.findByRole('button', {
          name: language === 'en' ? 'Send a new invitation' : '发送新邀请',
        }),
      )
      await screen.findByText(
        language === 'en' ? 'Invitation queued for delivery.' : '邀请已加入投递队列。',
      )
      const region = screen.getByRole('region', {
        name: language === 'en' ? 'Pending invitations' : '待接受的邀请',
      })
      expect(within(region).getAllByRole('listitem')).toHaveLength(1)
      expect(
        within(region).getByText(language === 'en' ? 'Pending' : '待接受', { selector: 'dd' }),
      ).toBeDefined()
      expect(api.to(RESEND)[0]?.body).toMatchObject({
        resend: true,
        invitationId: INVITATION.id,
        expectedGeneration: 1,
        email: INVITATION.email,
      })
      expect(api.to(RESEND)).toHaveLength(1)
      expect(api.to(READ)).toHaveLength(0)
      expect(api.to(NEW_READ).length).toBeGreaterThanOrEqual(1)
      await userEvent.click(
        screen.getByRole('button', {
          name: language === 'en' ? 'Check invitation status' : '检查邀请状态',
        }),
      )
      await waitFor(() => expect(api.to(NEW_READ).length).toBeGreaterThanOrEqual(2))
      expect(api.to(READ)).toHaveLength(0)
    },
  )

  it.each([
    ['en', 'A newer invitation exists for this address. Review the pending invitations.'],
    ['zh-CN', '此邮箱已有更新的邀请。请查看待接受的邀请。'],
  ] as const)(
    'explains a newer invitation without suggesting reload in %s',
    (language, message) => {
      chooseLanguage(language)
      display({
        ...INVITATION,
        status: 'expired',
        resendAllowed: false,
        resendDeniedReason: 'INVITATION_CONFLICT',
      })
      expect(screen.getByText(message)).toBeDefined()
    },
  )

  it('keeps the replacement ID for a status retry after its first read fails', async () => {
    let reads = 0
    const replacement = { ...INVITATION, id: NEW_INVITATION_ID }
    const api = fakeApi({
      [RESEND]: () => queued(replacement, 1),
      [READ]: () => json(200, { ...INVITATION, status: 'canceled', resendAllowed: false }),
      [NEW_READ]: () =>
        ++reads === 1
          ? json(503, {})
          : json(200, { ...replacement, delivery: { ...replacement.delivery, state: 'queued' } }),
    })
    display({ ...INVITATION, status: 'expired' })
    await userEvent.click(screen.getByRole('button', { name: 'Send a new invitation' }))
    await screen.findByText(
      'Could not confirm the invitation status. Check its status before trying another action.',
    )
    expect(
      (screen.getByRole('button', { name: 'Send a new invitation' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Check invitation status' }))
    await screen.findByText('Invitation queued for delivery.')
    expect(api.to(NEW_READ)).toHaveLength(2)
    expect(api.to(READ)).toHaveLength(0)
    expect(api.to(RESEND)).toHaveLength(1)
  })

  it.each([
    [503, 'INVITATION_DELIVERY_UNAVAILABLE', 'pending'],
    [409, 'INVITATION_INELIGIBLE', 'accepted'],
  ] as const)(
    'reads the saved replacement after dispatch returns %s %s',
    async (status, code, lifecycle) => {
      const replacement = {
        ...INVITATION,
        id: NEW_INVITATION_ID,
        status: lifecycle,
        resendAllowed: false,
        delivery: { ...INVITATION.delivery, state: 'queued' },
      }
      const api = fakeApi({
        [RESEND]: () => json(status, { code, invitationId: NEW_INVITATION_ID }),
        [READ]: () => json(200, { ...INVITATION, status: 'canceled', resendAllowed: false }),
        [NEW_READ]: () => json(200, replacement),
      })
      display({ ...INVITATION, status: 'expired' })
      await userEvent.click(screen.getByRole('button', { name: 'Send a new invitation' }))
      if (lifecycle === 'pending') {
        await screen.findByText(
          'The invitation was saved, but delivery could not be queued. Retry with the same email address.',
        )
        expect(screen.getByText('Pending', { selector: 'dd' })).toBeDefined()
      } else {
        await screen.findByText('The recipient has joined. Their membership was not changed.')
        expect(screen.queryByRole('alert')).toBeNull()
      }
      expect(api.to(READ)).toHaveLength(0)
      expect(api.to(NEW_READ)).toHaveLength(1)
      await userEvent.click(screen.getByRole('button', { name: 'Check invitation status' }))
      await waitFor(() => expect(api.to(NEW_READ)).toHaveLength(2))
      expect(api.to(RESEND)).toHaveLength(1)
      expect(api.to(READ)).toHaveLength(0)
    },
  )
})

const rowSource = readFileSync('apps/web/src/pages/team-invitations/InvitationRow.tsx', 'utf8')
function sourceCopy(source: string): typeof InvitationRow {
  const dependencies: Record<string, unknown> = {
    react,
    '../../api/auth.ts': auth,
    '../../api/client.ts': client,
    '../../api/errors.ts': errors,
    '../../components/BreakableText.tsx': breakable,
    '../../components/OrganizationContextConflict.tsx': conflict,
    '../../format.ts': format,
    '../../i18n/runtime.tsx': runtime,
    '../../i18n/translate.ts': translate,
  }
  return compileSource(source, dependencies, 'InvitationRow')
}

function compileSource<T>(
  source: string,
  dependencies: Record<string, unknown>,
  exported: string,
): T {
  const compiled = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { readFileSync } from 'node:fs'; import { transformSync } from 'esbuild'; process.stdout.write(transformSync(readFileSync(0, 'utf8'), { loader: 'tsx', format: 'cjs', jsxFactory: 'reactRuntime.createElement', jsxFragment: 'reactRuntime.Fragment' }).code)",
    ],
    { input: source, encoding: 'utf8' },
  )
  const module = { exports: {} as Record<string, T> }
  new Function('require', 'module', 'exports', 'reactRuntime', compiled)(
    (name: string) => {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`)
      return dependencies[name]
    },
    module,
    module.exports,
    react,
  )
  return module.exports[exported] as T
}

it.each([
  [
    'en',
    'No longer valid',
    'The inviter is no longer a team member. Cancel this invitation and send a fresh invitation in your own name.',
    'Cancel invitation',
    'Confirm cancellation',
  ],
  [
    'zh-CN',
    '已失效',
    '邀请人已不再是团队成员。请取消此邀请，再以你自己的名义发送一封全新邀请。',
    '取消邀请',
    '确认取消邀请',
  ],
] as const)(
  'explains void invitations in %s, disables resend and keeps cancellation',
  async (language, label, guidance, cancel, confirm) => {
    chooseLanguage(language)
    const api = fakeApi({
      [CANCEL]: () => json(200, { ...INVITATION, status: 'canceled', resendAllowed: false }),
      [READ]: () => json(200, { ...INVITATION, status: 'canceled', resendAllowed: false }),
    })
    display({
      ...INVITATION,
      invalidReason: 'inviter_left',
      resendAllowed: false,
      resendDeniedReason: 'INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION',
    })
    expect(screen.getByText(label, { selector: 'dd' })).toBeDefined()
    expect(screen.getByText(guidance)).toBeDefined()
    const resend = screen.getByRole<HTMLButtonElement>('button', {
      name: language === 'en' ? 'Resend invitation' : '重新发送邀请',
    })
    expect(resend.disabled).toBe(true)
    await userEvent.click(resend)
    expect(api.to(RESEND)).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: cancel }))
    await userEvent.click(screen.getByRole('button', { name: confirm }))
    await waitFor(() => expect(api.to(CANCEL)).toHaveLength(1))
  },
)

async function verifyRefreshedVoidNotice(Row: typeof InvitationRow) {
  fakeApi({
    [READ]: () =>
      json(200, {
        ...INVITATION,
        invalidReason: 'inviter_left',
        resendAllowed: false,
        resendDeniedReason: 'INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION',
        delivery: { ...INVITATION.delivery, state: 'queued' },
      }),
  })
  const view = display(INVITATION, Row)
  try {
    await userEvent.click(screen.getByRole('button', { name: 'Check invitation status' }))
    expect((await screen.findByRole('status')).textContent).toBe('Invitation status refreshed.')
    expect(screen.queryByText('Invitation queued for delivery.')).toBeNull()
    expect(screen.queryByText('No longer valid', { selector: 'dd' })).not.toBeNull()
  } finally {
    view.unmount()
  }
}

it('refreshes an invalid queued invitation without announcing delivery success', () =>
  verifyRefreshedVoidNotice(InvitationRow))

it('detects removal of the refreshed void-invitation notice guard in a production-source copy', async () => {
  await verifyRefreshedVoidNotice(sourceCopy(rowSource))
  const before = 'invitation.invalidReason === null &&'
  expect(rowSource.split(before)).toHaveLength(2)
  await expect(
    verifyRefreshedVoidNotice(sourceCopy(rowSource.replace(before, ''))),
  ).rejects.toMatchObject({ name: 'AssertionError' })
  await verifyRefreshedVoidNotice(sourceCopy(rowSource))
})

it('detects removed void-state display and resend controls in production-source copies', async () => {
  async function assertion(Row: typeof InvitationRow) {
    const view = display(
      {
        ...INVITATION,
        // The derived state itself must keep a stale positive eligibility from enabling resend.
        invalidReason: 'inviter_left',
      },
      Row,
    )
    try {
      expect(screen.queryByText('No longer valid', { selector: 'dd' })).not.toBeNull()
      expect(
        screen.getByText(
          'The inviter is no longer a team member. Cancel this invitation and send a fresh invitation in your own name.',
        ),
      ).toBeDefined()
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Resend invitation' }).disabled,
      ).toBe(true)
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel invitation' }).disabled,
      ).toBe(false)
    } finally {
      view.unmount()
    }
  }
  await assertion(sourceCopy(rowSource))
  for (const [before, after] of [
    [
      "invalid ? 'No longer valid' : statusLabels[invitation.status]",
      'statusLabels[invitation.status]',
    ],
    [
      'needsCheck || invalid || !invitation.resendAllowed',
      'needsCheck || !invitation.resendAllowed',
    ],
  ] as const) {
    expect(rowSource.split(before)).toHaveLength(2)
    await expect(assertion(sourceCopy(rowSource.replace(before, after)))).rejects.toMatchObject({
      name: 'AssertionError',
    })
  }
  await assertion(sourceCopy(rowSource))
})

it('detects optimistic row removal in a production-source copy while cancellation waits', async () => {
  async function assertion(Row: typeof InvitationRow) {
    const pending = later()
    const api = fakeApi({
      [CANCEL]: () => pending.response,
      [READ]: () => json(200, { ...INVITATION, status: 'canceled', resendAllowed: false }),
    })
    const view = display(INVITATION, Row)
    try {
      await userEvent.click(screen.getByRole('button', { name: 'Cancel invitation' }))
      await userEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }))
      await waitFor(() => expect(api.to(CANCEL)).toHaveLength(1))
      expect(
        screen.queryByRole('heading', { name: `Invitation to ${INVITATION.email}` }),
      ).not.toBeNull()
    } finally {
      await act(async () => {
        view.unmount()
        await pending.answer(json(200, {}))
      })
    }
  }
  await assertion(sourceCopy(rowSource))
  const before = '  return (\n    <li className="invitation-row stack"'
  expect(rowSource.split(before)).toHaveLength(2)
  const mutant = rowSource.replace(
    before,
    '  if (busy) return null\n  return (\n    <li className="invitation-row stack"',
  )
  await expect(assertion(sourceCopy(mutant))).rejects.toMatchObject({ name: 'AssertionError' })
  await assertion(sourceCopy(rowSource))
})

it('detects losing the replacement row or its feedback in production-source copies', async () => {
  const source = readFileSync('apps/web/src/pages/TeamInvitations.tsx', 'utf8')
  function managementCopy(code: string): typeof TeamInvitations {
    return compileSource(
      code,
      {
        react,
        '../api/auth.ts': auth,
        '../api/client.ts': client,
        '../api/errors.ts': errors,
        '../components/OrganizationContextConflict.tsx': conflict,
        '../i18n/runtime.tsx': runtime,
        '../i18n/translate.ts': translate,
        '../unsaved-changes.tsx': unsavedChanges,
        './team-invitations/InvitationRow.tsx': { InvitationRow },
      },
      'TeamInvitations',
    )
  }
  async function assertion(Management: typeof TeamInvitations) {
    let replaced = false
    const refreshed = later()
    const replacement = {
      ...INVITATION,
      id: NEW_INVITATION_ID,
      delivery: { ...INVITATION.delivery, state: 'queued' as const },
    }
    fakeApi({
      [LIST]: ({ path }) => {
        const status = new URL(path, location.origin).searchParams.get('status')
        if (!status && replaced)
          return json(200, {
            data: [{ ...INVITATION, status: 'canceled', resendAllowed: false }, replacement],
            nextCursor: null,
          })
        return replaced
          ? refreshed.response
          : json(200, {
              data: status === 'expired' ? [{ ...INVITATION, status: 'expired' }] : [],
              nextCursor: null,
            })
      },
      [RESEND]: () => {
        replaced = true
        return queued(replacement, 1)
      },
      [NEW_READ]: () => json(200, replacement),
      [READ]: () => json(200, { ...INVITATION, status: 'canceled', resendAllowed: false }),
    })
    const view = render(
      <InterfaceScope surface="admin">
        <UnsavedChangesProvider>
          <Management organizationId={ORGANIZATION_ID} />
        </UnsavedChangesProvider>
      </InterfaceScope>,
    )
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await screen.findByText('No pending invitations on this page.')
      await userEvent.selectOptions(
        screen.getByRole('combobox', { name: 'Filter invitations' }),
        'expired',
      )
      await userEvent.click(await screen.findByRole('button', { name: 'Send a new invitation' }))
      await waitFor(() =>
        expect(screen.queryByText('Invitation queued for delivery.')).not.toBeNull(),
      )
      expect(screen.getAllByRole('listitem')).toHaveLength(1)
      expect(screen.queryByText('Expired', { selector: 'dd' })).toBeNull()
      expect(screen.getByText('Pending', { selector: 'dd' })).toBeDefined()
      await refreshed.answer(json(200, { data: [], nextCursor: null }))
      await userEvent.selectOptions(
        screen.getByRole('combobox', { name: 'Filter invitations' }),
        'all',
      )
      await screen.findByText('Cancelled', { selector: 'dd' })
      expect(screen.getAllByRole('listitem')).toHaveLength(2)
      expect(screen.getByText('Pending', { selector: 'dd' })).toBeDefined()
      expect(screen.getAllByRole('button', { name: 'Cancel invitation' })).toHaveLength(1)
      expect(
        consoleError.mock.calls.some(([message]) => String(message).includes('same key')),
      ).toBe(false)
    } finally {
      view.unmount()
      await refreshed.answer(json(200, { data: [], nextCursor: null }))
      consoleError.mockRestore()
    }
  }
  await assertion(managementCopy(source))
  for (const [before, after] of [
    ['key={rowKeys.current.get(invitation.id) ?? invitation.id}', 'key={invitation.id}'],
    ['row.id === invitation.id', 'row.id === summary.id'],
    ['rowKeys.current.set(invitation.id,', 'rowKeys.current.get(invitation.id,'],
  ] as const) {
    expect(source.split(before)).toHaveLength(2)
    await expect(assertion(managementCopy(source.replace(before, after)))).rejects.toMatchObject({
      name: 'AssertionError',
    })
  }
  await assertion(managementCopy(source))
})

it('detects reading the old invitation after replacement in a production-source copy', async () => {
  async function assertion(Row: typeof InvitationRow, dispatchFailed = false) {
    const replacement = {
      ...INVITATION,
      id: NEW_INVITATION_ID,
      delivery: { ...INVITATION.delivery, state: 'queued' as const },
    }
    const api = fakeApi({
      [RESEND]: () =>
        dispatchFailed
          ? json(503, { code: 'INVITATION_DELIVERY_UNAVAILABLE', invitationId: NEW_INVITATION_ID })
          : queued(replacement, 1),
      [NEW_READ]: () => json(200, replacement),
      [READ]: () => json(200, { ...INVITATION, status: 'canceled', resendAllowed: false }),
    })
    const view = display({ ...INVITATION, status: 'expired' }, Row)
    try {
      await userEvent.click(screen.getByRole('button', { name: 'Send a new invitation' }))
      await waitFor(() => expect(api.to(NEW_READ)).toHaveLength(1))
      expect(api.to(READ)).toHaveLength(0)
      await screen.findByText(
        dispatchFailed
          ? 'The invitation was saved, but delivery could not be queued. Retry with the same email address.'
          : 'Invitation queued for delivery.',
      )
    } finally {
      view.unmount()
    }
  }
  await assertion(sourceCopy(rowSource))
  const before = 'currentInvitationId.current = result.id'
  expect(rowSource.split(before)).toHaveLength(2)
  const mutant = rowSource.replace(before, 'currentInvitationId.current = invitation.id')
  await expect(assertion(sourceCopy(mutant))).rejects.toMatchObject({ name: 'AssertionError' })
  await assertion(sourceCopy(rowSource), true)
  const beforeFailure = 'currentInvitationId.current = caught.invitationId'
  expect(rowSource.split(beforeFailure)).toHaveLength(2)
  await expect(
    assertion(sourceCopy(rowSource.replace(beforeFailure, 'void caught.invitationId')), true),
  ).rejects.toMatchObject({ name: 'AssertionError' })
  await assertion(sourceCopy(rowSource))
})

it.each(['expired', 'pending', 'gateway'] as const)(
  'keeps a lost replacement response uncertain from %s when only the old canceled ID is known',
  async (initial) => {
    async function assertion(Row: typeof InvitationRow) {
      const api = fakeApi({
        [RESEND]: () => {
          if (initial === 'gateway') return json(504, {})
          throw new TypeError('response unavailable')
        },
        [READ]: () => json(200, { ...INVITATION, status: 'canceled', resendAllowed: false }),
      })
      const button = initial === 'expired' ? 'Send a new invitation' : 'Resend invitation'
      const view = display(
        { ...INVITATION, status: initial === 'expired' ? 'expired' : 'pending' },
        Row,
      )
      try {
        await userEvent.click(screen.getByRole('button', { name: button }))
        await waitFor(() => expect(api.to(READ)).toHaveLength(1))
        expect(
          screen.queryByText('Invitation cancelled. Its link can no longer be used.'),
        ).toBeNull()
        await screen.findByText(
          'A new invitation may have been saved. Review Pending invitations before trying another action.',
        )
        expect((screen.getByRole('button', { name: button }) as HTMLButtonElement).disabled).toBe(
          true,
        )
        await userEvent.click(screen.getByRole('button', { name: 'Check invitation status' }))
        await waitFor(() => expect(api.to(READ)).toHaveLength(2))
        expect(
          screen.queryByText('Invitation cancelled. Its link can no longer be used.'),
        ).toBeNull()
        expect(screen.getByRole('alert')).toBeDefined()
        expect(api.to(RESEND)).toHaveLength(1)
      } finally {
        view.unmount()
      }
    }
    await assertion(InvitationRow)
    await assertion(sourceCopy(rowSource))
    if (initial !== 'expired') {
      const before = "action === 'resend' &&"
      expect(rowSource.split(before)).toHaveLength(2)
      await expect(
        assertion(
          sourceCopy(
            rowSource.replace(before, "action === 'resend' && invitation.status === 'expired' &&"),
          ),
        ),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    }
    if (initial === 'gateway') {
      const before = 'caught.status >= 500'
      expect(rowSource.split(before)).toHaveLength(2)
      await expect(assertion(sourceCopy(rowSource.replace(before, 'false')))).rejects.toMatchObject(
        {
          name: 'AssertionError',
        },
      )
    }
    const before = "current.status === 'canceled' && replacementFailure.current"
    expect(rowSource.split(before)).toHaveLength(2)
    await expect(assertion(sourceCopy(rowSource.replace(before, 'false')))).rejects.toMatchObject({
      name: 'AssertionError',
    })
    await assertion(sourceCopy(rowSource))
  },
)
