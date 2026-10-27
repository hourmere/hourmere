import { describe, expect, it, vi } from 'vitest'
import { getActiveOrganizationMember, type OrganizationMember } from './auth.ts'
import { onUnauthorized } from './client.ts'
import { RequestError } from './errors.ts'

const MEMBER: OrganizationMember = {
  id: 'membership-1',
  userId: 'user-1',
  organizationId: 'organization-1',
  role: 'admin',
  createdAt: '2026-10-27T10:00:00.000Z',
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('the active organization membership adapter', () => {
  it('reads only the caller membership and preserves the actual role', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(200, MEMBER))
    vi.stubGlobal('fetch', fetch)
    expect(await getActiveOrganizationMember()).toEqual(MEMBER)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/organization/get-active-member', {
      method: 'GET',
    })
  })

  it('forwards cancellation without changing the endpoint protocol', async () => {
    const controller = new AbortController()
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(200, MEMBER))
    vi.stubGlobal('fetch', fetch)
    await getActiveOrganizationMember(controller.signal)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/organization/get-active-member', {
      method: 'GET',
      signal: controller.signal,
    })
  })

  it('uses the shared expired-session notification and error conversion', async () => {
    const unauthorized = vi.fn()
    const unregister = onUnauthorized(unauthorized)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json(401, { code: 'UNAUTHORIZED', message: 'Sign in again.' })),
    )
    try {
      await expect(getActiveOrganizationMember()).rejects.toMatchObject({
        name: 'RequestError',
        status: 401,
        code: 'UNAUTHORIZED',
      })
      expect(unauthorized).toHaveBeenCalledTimes(1)
    } finally {
      unregister()
    }
  })

  it('preserves a membership failure rather than inventing a role', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json(400, { code: 'MEMBER_NOT_FOUND', message: 'No member.' })),
    )
    const error = await getActiveOrganizationMember().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(RequestError)
    expect(error).toMatchObject({ status: 400, code: 'MEMBER_NOT_FOUND' })
  })

  it('does not retry a failed read automatically', async () => {
    const failure = new TypeError('Failed to fetch')
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(failure)
    vi.stubGlobal('fetch', fetch)
    await expect(getActiveOrganizationMember()).rejects.toBe(failure)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
