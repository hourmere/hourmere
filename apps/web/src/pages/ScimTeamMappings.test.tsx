import '../i18n/admin.ts'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '../api/client.ts'
import { AccountLanguage, InterfaceScope } from '../i18n/runtime.tsx'
import { emptyTeamLists, fakeApi, json, ME, renderApp, signedInAs } from '../test/fake-api.tsx'
import { ScimTeamMappings } from './ScimTeamMappings.tsx'

const parent = '90000000-0000-7000-8000-000000000001'
const child = '90000000-0000-7000-8000-000000000002'
const connection = '90000000-0000-7000-8000-000000000003'
const mappingId = '90000000-0000-7000-8000-000000000004'
const proofAttemptId = '90000000-0000-7000-8000-000000000005'
const base = '/api/v1/scim/team-mappings'
const consent = `POST ${base}/consent`
const send = 'POST /api/auth/sso/mailbox-proof/send'
const consume = 'POST /api/auth/sso/mailbox-proof/consume'
const mapping: Schemas['ScimTeamMapping'] = {
  id: mappingId,
  parentOrganizationId: parent,
  childOrganizationId: child,
  connectionId: connection,
  externalId: 'Engineering North 中国',
  state: 'suspended',
}

function view(organizationId = parent, role: string | null = 'owner', locale = 'en') {
  return (
    <InterfaceScope surface="admin">
      <AccountLanguage locale={locale}>
        <ScimTeamMappings
          key={organizationId}
          organizationId={organizationId}
          role={role}
          stepUpProviders={[]}
        />
      </AccountLanguage>
    </InterfaceScope>
  )
}

describe('SCIM team mappings', () => {
  it.each([false, undefined])(
    'keeps mapping UI hidden when resource discovery is %s',
    async (on) => {
      const api = fakeApi({
        ...signedInAs({ ...ME, organization: { ...ME.organization, id: parent, personal: false } }),
        ...emptyTeamLists,
        'GET /api/v1/instance': () =>
          json(200, { scimProvisioningEnabled: true, scimResourcesEnabled: on }),
      })
      renderApp('/app/settings')
      await screen.findByRole('heading', { name: 'SCIM provisioning tokens' })
      expect(screen.queryByRole('heading', { name: 'SCIM team mappings' })).toBeNull()
      expect(api.to(`GET ${base}`)).toHaveLength(0)
    },
  )

  it('lets administrators read safe metadata in Chinese and keeps approval controls owner-only', async () => {
    const api = fakeApi({
      [`GET ${base}`]: () =>
        json(200, { mappings: [mapping], connectionId: null, linkGeneration: null }),
    })
    render(view(child, 'admin', 'zh-CN'))
    expect(await screen.findByRole('heading', { name: 'SCIM 团队映射' })).toBeDefined()
    await screen.findByText('目录管理权限已暂停')
    expect(screen.getByText(mapping.externalId)).toBeDefined()
    expect(screen.queryByRole('button', { name: '准备解除关联的请求' })).toBeNull()
    expect(screen.queryByRole('button', { name: '打开共享的审批请求' })).toBeNull()
    expect(api.to(`GET ${base}`)[0]?.headers.get('X-Expected-Organization-Id')).toBe(child)
  })

  it('shows uniform unavailability on denial and does not enable writes', async () => {
    fakeApi({
      [`GET ${base}`]: () =>
        json(403, { error: 'scim_mapping_access_denied', message: 'private-detail' }),
    })
    render(view())
    expect(
      await screen.findByText('SCIM team mappings are unavailable in this team.'),
    ).toBeDefined()
    expect(screen.queryByText(/private-detail/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Prepare link request' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open shared approval request' })).toBeNull()
  })

  it('uses one reviewed request and separate mailbox proofs in both owner contexts', async () => {
    const approved = new Set<string>()
    let linked = false
    const api = fakeApi({
      [`GET ${base}`]: ({ headers }) =>
        json(200, {
          mappings: linked ? [{ ...mapping, state: 'pending' }] : [],
          connectionId: headers.get('X-Expected-Organization-Id') === parent ? connection : null,
          linkGeneration: 0,
        }),
      [consent]: ({ body, headers }) => {
        const proof = body as { proofAttemptId?: string; intentId: string }
        if (!proof.proofAttemptId) {
          return json(403, {
            error: 'sso_reauthentication_required',
            attemptId: proofAttemptId,
            proofMethods: ['mailbox'],
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          })
        }
        approved.add(headers.get('X-Expected-Organization-Id') ?? '')
        return json(200, { intentId: proof.intentId })
      },
      [send]: () => json(202, { status: 'queued' }),
      [consume]: () => json(200, { status: 'proven' }),
      [`POST ${base}`]: () => {
        if (approved.size !== 2) return json(403, { error: 'scim_mapping_access_denied' })
        linked = true
        return json(201, { mappingId, generation: 1 })
      },
    })
    const user = userEvent.setup()
    const panel = render(view())
    const click = (name: string) => user.click(screen.getByRole('button', { name }))
    const paste = async (label: string, value: string) => {
      await user.click(await screen.findByLabelText(label, { exact: true }))
      await user.paste(value)
    }
    async function approve() {
      await click('Approve for this team')
      await screen.findByRole('heading', {
        name: 'Confirm your identity to approve this SCIM mapping request.',
      })
      await click('Send verification email')
      await paste(
        'Email verification link',
        `${window.location.origin}/app/mailbox-proof#attempt=${proofAttemptId}&token=${'a'.repeat(43)}`,
      )
      await click('Verify email link')
      await screen.findByText('Email verification complete.')
      await click('Continue')
      await screen.findByText(/Your approval is recorded/)
    }

    await user.click(await screen.findByRole('button', { name: 'Prepare link request' }))
    await paste('Child team ID', child)
    await user.type(screen.getByLabelText('Child team link generation'), '0')
    await paste('Group external ID', mapping.externalId)
    await click('Review request')
    const shared = (screen.getByLabelText('Shareable approval request') as HTMLTextAreaElement)
      .value
    const original = JSON.parse(shared)
    expect(original).toEqual({
      action: 'link',
      intentId: expect.any(String),
      parentOrganizationId: parent,
      childOrganizationId: child,
      connectionId: connection,
      linkGeneration: 0,
      externalId: mapping.externalId,
      allowGroupRetirement: true,
    })
    expect(api.to(consent)).toHaveLength(0)
    await approve()
    await click('Apply link')
    await screen.findByText(/Both owners must approve the same request/)

    panel.rerender(view(child))
    await user.click(await screen.findByRole('button', { name: 'Open shared approval request' }))
    await paste('Shared approval request', shared)
    await click('Review request')
    expect(screen.getByText(mapping.externalId)).toBeDefined()
    await approve()
    await click('Apply link')
    await screen.findByText('SCIM team mapping linked.')
    await screen.findByText('Awaiting directory Group')
    expect(
      api.to(consent).map(({ body, headers }) => [body, headers.get('X-Expected-Organization-Id')]),
    ).toEqual([
      [original, parent],
      [{ ...original, proofAttemptId }, parent],
      [original, child],
      [{ ...original, proofAttemptId }, child],
    ])
    expect(
      api
        .to(`POST ${base}`)
        .map(({ body, headers }) => [body, headers.get('X-Expected-Organization-Id')]),
    ).toEqual([
      [{ intentId: original.intentId }, parent],
      [{ intentId: original.intentId }, child],
    ])
  })

  it('validates a pasted request locally and finalizes an unlink with the reviewed mapping ID', async () => {
    const api = fakeApi({
      [`GET ${base}`]: () =>
        json(200, { mappings: [mapping], connectionId: null, linkGeneration: 2 }),
      [`DELETE ${base}/${mappingId}`]: () =>
        json(409, { error: 'scim_mapping_roster_requires_departure' }),
    })
    const user = userEvent.setup()
    render(view(child))
    await user.click(await screen.findByRole('button', { name: 'Open shared approval request' }))
    await user.click(screen.getByLabelText('Shared approval request'))
    await user.paste(JSON.stringify({ action: 'unlink', mappingId }))
    await user.click(screen.getByRole('button', { name: 'Review request' }))
    await screen.findByText('Check that the approval request is complete and includes this team.')
    expect(api.calls).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Prepare unlink request' }))
    const shared = (screen.getByLabelText('Shareable approval request') as HTMLTextAreaElement)
      .value
    await user.click(screen.getByRole('button', { name: 'Apply unlink' }))
    await screen.findByText(
      'The child team must resolve its managed memberships before detaching this mapping.',
    )
    await waitFor(() =>
      expect(api.to(`DELETE ${base}/${mappingId}`)[0]?.body).toEqual({
        intentId: JSON.parse(shared).intentId,
      }),
    )
    expect(api.to(consent)).toHaveLength(0)
  })
})
