import { describe, expect, it, vi } from 'vitest'
import type { OrganizationMember } from './auth.ts'
import { onUnauthorized } from './client.ts'
import { RequestError } from './errors.ts'
import { changeTeamMemberRole } from './team-roles.ts'

const ORGANIZATION_ID = '00000000-0000-7000-8000-000000000010'
const MEMBER: OrganizationMember = {
  id: '00000000-0000-7000-8000-000000000011',
  organizationId: ORGANIZATION_ID,
  userId: '00000000-0000-7000-8000-000000000012',
  role: 'member',
  createdAt: '2026-10-27T10:00:00.000Z',
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('the team role adapter', () => {
  it.each(['admin', 'member'] as const)(
    'binds a fixed %s change and cancellation to the displayed organization',
    async (role) => {
      const controller = new AbortController()
      const confirmed = { ...MEMBER, role }
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(200, confirmed))
      vi.stubGlobal('fetch', fetch)
      expect(
        await changeTeamMemberRole(ORGANIZATION_ID, MEMBER.id, role, controller.signal),
      ).toEqual(confirmed)
      expect(fetch).toHaveBeenCalledTimes(1)
      const [url, request] = fetch.mock.calls[0] ?? []
      expect(url).toBe('/api/auth/organization/update-member-role')
      expect(request?.method).toBe('POST')
      expect(new Headers(request?.headers).get('content-type')).toBe('application/json')
      expect(new Headers(request?.headers).get('X-Expected-Organization-Id')).toBe(ORGANIZATION_ID)
      expect(JSON.parse(String(request?.body))).toEqual({
        organizationId: ORGANIZATION_ID,
        memberId: MEMBER.id,
        role,
      })
      expect(request?.signal).toBe(controller.signal)
    },
  )

  it('retains the server denial for a crafted role request instead of returning a changed role', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json(403, {
        code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
        message: 'team_management_access_denied',
      }),
    )
    vi.stubGlobal('fetch', fetch)
    const error = await changeTeamMemberRole(ORGANIZATION_ID, MEMBER.id, 'admin').catch(
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(RequestError)
    expect(error).toMatchObject({ status: 403, code: 'TEAM_MANAGEMENT_ACCESS_DENIED' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    { label: 'invalid JSON', body: undefined },
    { label: 'null', body: null },
    { label: 'an empty response object', body: {} },
    { label: 'a missing member id', body: { ...MEMBER, role: 'admin', id: undefined } },
    { label: 'a numeric member id', body: { ...MEMBER, role: 'admin', id: 123 } },
    { label: 'a different member', body: { ...MEMBER, role: 'admin', id: 'another-member' } },
    {
      label: 'a missing organization',
      body: { ...MEMBER, role: 'admin', organizationId: undefined },
    },
    { label: 'a numeric organization', body: { ...MEMBER, role: 'admin', organizationId: 123 } },
    {
      label: 'another organization',
      body: { ...MEMBER, role: 'admin', organizationId: 'another-team' },
    },
    { label: 'the old role', body: MEMBER },
    { label: 'an owner role', body: { ...MEMBER, role: 'owner' } },
    { label: 'a missing user', body: { ...MEMBER, role: 'admin', userId: undefined } },
    { label: 'a numeric user', body: { ...MEMBER, role: 'admin', userId: 123 } },
    { label: 'a missing creation time', body: { ...MEMBER, role: 'admin', createdAt: undefined } },
    { label: 'a numeric creation time', body: { ...MEMBER, role: 'admin', createdAt: 123 } },
  ])('rejects an unconfirmed successful status containing $label', async ({ body }) => {
    const response =
      body === undefined ? new Response('not JSON', { status: 200 }) : json(200, body)
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetch)
    await expect(changeTeamMemberRole(ORGANIZATION_ID, MEMBER.id, 'admin')).rejects.toMatchObject({
      name: 'RequestError',
      status: 502,
      code: 'ROLE_CHANGE_UNCONFIRMED',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('preserves organization drift as a conflict without automatically repeating the write', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        json(409, { code: 'ORGANIZATION_CONTEXT_CHANGED', message: 'Reload this team.' }),
      )
    vi.stubGlobal('fetch', fetch)
    await expect(changeTeamMemberRole(ORGANIZATION_ID, MEMBER.id, 'admin')).rejects.toMatchObject({
      status: 409,
      code: 'ORGANIZATION_CONTEXT_CHANGED',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('notifies the shared session gate when the server reports an expired session', async () => {
    const unauthorized = vi.fn()
    const unregister = onUnauthorized(unauthorized)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(401, { code: 'UNAUTHORIZED' })))
    try {
      await expect(
        changeTeamMemberRole(ORGANIZATION_ID, MEMBER.id, 'member'),
      ).rejects.toMatchObject({
        status: 401,
        code: 'UNAUTHORIZED',
      })
      expect(unauthorized).toHaveBeenCalledTimes(1)
    } finally {
      unregister()
    }
  })

  it('preserves a network failure without retrying a possibly committed write', async () => {
    const error = new TypeError('Failed to fetch')
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(error)
    vi.stubGlobal('fetch', fetch)
    await expect(changeTeamMemberRole(ORGANIZATION_ID, MEMBER.id, 'admin')).rejects.toBe(error)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
