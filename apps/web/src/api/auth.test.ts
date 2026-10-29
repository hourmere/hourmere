import { describe, expect, it, vi } from 'vitest'
import { translateMessage } from '../i18n/translate.ts'
import {
  type AcceptedInvitation,
  acceptInvitation,
  type CreatedOrganization,
  type CreateOrganizationInput,
  createOrganization,
  getInvitation,
  type InvitationDetails,
  listOrganizations,
  type Organization,
  type SignInRedirects,
  sendSignInLink,
  setActiveOrganization,
  startSocialSignIn,
} from './auth.ts'
import { onUnauthorized, type Schemas } from './client.ts'
import { errorMessage, RequestError, UNREACHABLE } from './errors.ts'

const PERSONAL_ME: Schemas['Me'] = {
  user: { id: '00000000-0000-7000-8000-000000000001', name: 'Ada', email: 'ada@example.com' },
  organization: {
    id: '00000000-0000-7000-8000-000000000002',
    name: 'Ada',
    slug: 'ada',
    personal: true,
  },
  principal: { kind: 'session', apiKeyId: null },
}
const ORGANIZATION: Organization = {
  id: '00000000-0000-7000-8000-000000000003',
  name: 'Example team',
  slug: 'example-team',
  logo: null,
  createdAt: '2026-10-27T09:00:00.000Z',
}
const CREATED: CreatedOrganization = {
  ...ORGANIZATION,
  metadata: { project: 'Scheduling' },
  members: [
    {
      id: '00000000-0000-7000-8000-000000000004',
      organizationId: ORGANIZATION.id,
      userId: PERSONAL_ME.user.id,
      role: 'owner',
      createdAt: ORGANIZATION.createdAt,
    },
  ],
}
const TEAM_ME: Schemas['Me'] = {
  ...PERSONAL_ME,
  organization: {
    id: ORGANIZATION.id,
    name: ORGANIZATION.name,
    slug: ORGANIZATION.slug,
    personal: false,
  },
}
const INPUT: CreateOrganizationInput = { name: ORGANIZATION.name, slug: ORGANIZATION.slug }
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

function scriptedFetch(...responses: (Response | Promise<Response>)[]) {
  const fetch = vi.fn<typeof globalThis.fetch>()
  for (const response of responses) fetch.mockImplementationOnce(async () => response)
  fetch.mockImplementation(() => Promise.reject(new Error('Unexpected additional request')))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

const adapters = [
  {
    name: 'create',
    run: (signal?: AbortSignal) => createOrganization(INPUT, signal),
    path: '/api/auth/organization/create',
  },
  {
    name: 'set-active',
    run: (signal?: AbortSignal) =>
      setActiveOrganization({ organizationId: ORGANIZATION.id }, signal),
    path: '/api/auth/organization/set-active',
  },
  {
    name: 'list',
    run: (signal?: AbortSignal) => listOrganizations(signal),
    path: '/api/auth/organization/list',
  },
] as const

describe('organization adapters', () => {
  it('posts create input, preserves the member shape, and returns the active team confirmed by /me', async () => {
    const fetch = scriptedFetch(json(200, CREATED), json(200, TEAM_ME))
    const input: CreateOrganizationInput = {
      ...INPUT,
      logo: 'https://example.test/logo.png',
      metadata: { project: 'Scheduling' },
      keepCurrentActiveOrganization: false,
    }

    const result = await createOrganization(input)

    expect(result).toEqual({ organization: CREATED, me: TEAM_ME })
    expect(result.organization.members[0]).toEqual({
      id: '00000000-0000-7000-8000-000000000004',
      organizationId: ORGANIZATION.id,
      userId: PERSONAL_ME.user.id,
      role: 'owner',
      createdAt: ORGANIZATION.createdAt,
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0]).toEqual([
      '/api/auth/organization/create',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
    ])
    const confirmation = fetch.mock.calls[1]?.[0] as Request
    expect(confirmation.url).toBe(`${window.location.origin}/api/v1/me`)
    expect(confirmation.method).toBe('GET')
  })

  it('uses the minimal create body and supports an explicitly cleared logo', async () => {
    const fetch = scriptedFetch(json(200, CREATED), json(200, TEAM_ME))
    await createOrganization({ ...INPUT, logo: null })
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ ...INPUT, logo: null })
  })

  it.each([undefined, true])(
    'trusts /me when creation leaves the personal organization active (keepCurrentActiveOrganization=%s)',
    async (keepCurrentActiveOrganization) => {
      const fetch = scriptedFetch(json(200, CREATED), json(200, PERSONAL_ME))
      const input = {
        ...INPUT,
        ...(keepCurrentActiveOrganization !== undefined && { keepCurrentActiveOrganization }),
      }
      const result = await createOrganization(input)
      expect(result.organization.id).toBe(ORGANIZATION.id)
      expect(result.me).toEqual(PERSONAL_ME)
      expect(result.me.organization.id).not.toBe(result.organization.id)
      expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(input)
    },
  )

  it('waits for creation before reading /me, and waits for /me before resolving', async () => {
    const create = Promise.withResolvers<Response>()
    const me = Promise.withResolvers<Response>()
    const fetch = scriptedFetch(create.promise, me.promise)
    const resolved = vi.fn()
    const result = createOrganization(INPUT).then(resolved)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(resolved).not.toHaveBeenCalled()

    create.resolve(json(200, CREATED))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(resolved).not.toHaveBeenCalled()
    me.resolve(json(200, TEAM_ME))
    await result
    expect(resolved).toHaveBeenCalledExactlyOnceWith({ organization: CREATED, me: TEAM_ME })
  })

  it('propagates a failed confirmation instead of returning creation as confirmed state', async () => {
    const fetch = scriptedFetch(
      json(200, CREATED),
      json(503, { error: 'service_unavailable', message: 'Confirmation unavailable.' }),
    )
    await expect(createOrganization(INPUT)).rejects.toMatchObject({
      name: 'RequestError',
      status: 503,
      code: 'service_unavailable',
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('returns the list directly, including the raw metadata representation', async () => {
    const listed: Organization[] = [
      { ...ORGANIZATION, metadata: '{"project":"Scheduling"}' },
      { ...ORGANIZATION, id: PERSONAL_ME.organization.id, metadata: null },
    ]
    const fetch = scriptedFetch(json(200, listed))
    expect(await listOrganizations()).toEqual(listed)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/organization/list', { method: 'GET' })
  })

  it.each([
    { organizationId: ORGANIZATION.id },
    { organizationSlug: ORGANIZATION.slug },
    { organizationId: ORGANIZATION.id, organizationSlug: 'ignored-by-server' },
    {},
  ])('posts the set-active body unchanged and returns its organization: %j', async (input) => {
    const fetch = scriptedFetch(json(200, ORGANIZATION))
    expect(await setActiveOrganization(input)).toEqual(ORGANIZATION)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/organization/set-active', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  })

  it('can clear the active organization and preserves the null response', async () => {
    const fetch = scriptedFetch(json(200, null))
    expect(await setActiveOrganization({ organizationId: null })).toBeNull()
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ organizationId: null })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('sends the opening organization separately from the explicit activation target', async () => {
    const fetch = scriptedFetch(json(200, ORGANIZATION))
    await setActiveOrganization(
      { organizationId: ORGANIZATION.id },
      undefined,
      PERSONAL_ME.organization.id,
    )
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/organization/set-active', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Expected-Organization-Id': PERSONAL_ME.organization.id,
      },
      body: JSON.stringify({ organizationId: ORGANIZATION.id }),
    })
  })

  it.each(adapters)('reuses shared 401 handling for $name', async ({ run, path }) => {
    const unauthorized = vi.fn()
    const unregister = onUnauthorized(unauthorized)
    const fetch = scriptedFetch(
      json(401, { code: 'UNAUTHORIZED', message: 'Authentication needed.' }),
    )
    try {
      await expect(run()).rejects.toMatchObject({
        name: 'RequestError',
        status: 401,
        code: 'UNAUTHORIZED',
      })
      expect(unauthorized).toHaveBeenCalledTimes(1)
      expect(fetch.mock.calls[0]?.[0]).toBe(path)
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      unregister()
    }
  })

  it('reuses /me session-expiry handling after creation', async () => {
    const unauthorized = vi.fn()
    const unregister = onUnauthorized(unauthorized)
    scriptedFetch(json(200, CREATED), json(401, { error: 'unauthorized' }))
    try {
      await expect(createOrganization(INPUT)).rejects.toMatchObject({
        name: 'RequestError',
        status: 401,
        code: 'unauthorized',
      })
      expect(unauthorized).toHaveBeenCalledTimes(1)
    } finally {
      unregister()
    }
  })

  it.each(adapters)('preserves structured server errors for $name', async ({ run }) => {
    scriptedFetch(
      json(403, { code: 'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION', message: 'Denied.' }),
    )
    const error = await run().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(RequestError)
    expect(error).toMatchObject({ status: 403, code: 'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION' })
  })

  it.each(adapters)(
    'keeps network failures available to shared error translation for $name',
    async ({ run }) => {
      const failure = new TypeError('Failed to fetch')
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure))
      await expect(run()).rejects.toBe(failure)
      expect(translateMessage('en', errorMessage(failure))).toBe(UNREACHABLE)
      expect(translateMessage('zh-CN', errorMessage(failure))).toBe(
        '无法连接 Hourmere。请检查网络连接后重试。',
      )
    },
  )

  it.each(adapters)('forwards cancellation to the $name auth request', async ({ run, name }) => {
    const controller = new AbortController()
    const fetch = scriptedFetch(
      json(200, name === 'list' ? [ORGANIZATION] : name === 'create' ? CREATED : ORGANIZATION),
      json(200, TEAM_ME),
    )
    await run(controller.signal)
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal)
    if (name === 'create') {
      const confirmation = fetch.mock.calls[1]?.[0] as Request
      expect(confirmation.signal.aborted).toBe(false)
      controller.abort()
      expect(confirmation.signal.aborted).toBe(true)
    }
  })

  it.each(adapters)('preserves abort rejection for an in-flight $name request', async ({ run }) => {
    const controller = new AbortController()
    const aborted = new DOMException('The operation was aborted.', 'AbortError')
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(aborted), { once: true })
        }),
    )
    vi.stubGlobal('fetch', fetch)
    const pending = run(controller.signal)
    const rejected = expect(pending).rejects.toBe(aborted)
    controller.abort()
    await rejected
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('can cancel the confirmation read after creation completes', async () => {
    const controller = new AbortController()
    const aborted = new DOMException('The operation was aborted.', 'AbortError')
    const confirmationStarted = Promise.withResolvers<void>()
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, CREATED))
      .mockImplementationOnce(
        (input) =>
          new Promise((_resolve, reject) => {
            const request = input as Request
            request.signal.addEventListener('abort', () => reject(aborted), { once: true })
            confirmationStarted.resolve()
          }),
      )
    vi.stubGlobal('fetch', fetch)
    const pending = createOrganization(INPUT, controller.signal)
    const rejected = expect(pending).rejects.toBe(aborted)
    await confirmationStarted.promise
    controller.abort()
    await rejected
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

const INVITATION: InvitationDetails = {
  id: '00000000-0000-7000-8000-000000000005',
  email: 'ada@example.com',
  role: 'member',
  organizationId: ORGANIZATION.id,
  inviterId: '00000000-0000-7000-8000-000000000006',
  status: 'pending',
  expiresAt: '2026-10-29T09:00:00.000Z',
  createdAt: ORGANIZATION.createdAt,
  organizationName: ORGANIZATION.name,
  organizationSlug: ORGANIZATION.slug,
  inviterEmail: 'grace@example.com',
}
const ACCEPTED: AcceptedInvitation = {
  invitation: { ...INVITATION, status: 'accepted' },
  member: {
    id: '00000000-0000-7000-8000-000000000007',
    organizationId: ORGANIZATION.id,
    userId: PERSONAL_ME.user.id,
    role: 'member',
    createdAt: ORGANIZATION.createdAt,
  },
}
const invitationAdapters = [
  {
    name: 'lookup',
    run: (signal?: AbortSignal) => getInvitation(INVITATION.id, signal),
    response: INVITATION,
  },
  {
    name: 'accept',
    run: (signal?: AbortSignal) => acceptInvitation(INVITATION.id, signal),
    response: ACCEPTED,
  },
]

describe('invitation adapters', () => {
  it('gets invitation details with query id and does not accept or switch organizations', async () => {
    const fetch = scriptedFetch(json(200, INVITATION))
    expect(await getInvitation(INVITATION.id)).toEqual(INVITATION)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `/api/auth/organization/get-invitation?id=${INVITATION.id}`,
      { method: 'GET' },
    )
  })

  it('encodes the lookup value as one query field', async () => {
    const fetch = scriptedFetch(json(400, { code: 'INVALID_ID' }))
    await expect(getInvitation('bad&id=another')).rejects.toMatchObject({ code: 'INVALID_ID' })
    expect(fetch.mock.calls[0]?.[0]).toBe(
      '/api/auth/organization/get-invitation?id=bad%26id%3Danother',
    )
  })

  it('posts explicit acceptance with invitationId and preserves invitation plus membership', async () => {
    const fetch = scriptedFetch(json(200, ACCEPTED))
    expect(await acceptInvitation(INVITATION.id)).toEqual(ACCEPTED)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/organization/accept-invitation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invitationId: INVITATION.id }),
    })
  })

  it.each(invitationAdapters)('reuses shared unauthorized handling for $name', async ({ run }) => {
    const unauthorized = vi.fn()
    const unregister = onUnauthorized(unauthorized)
    const fetch = scriptedFetch(json(401, { code: 'UNAUTHORIZED' }))
    try {
      await expect(run()).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' })
      expect(unauthorized).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      unregister()
    }
  })

  it.each(invitationAdapters)(
    'preserves structured recipient errors for $name',
    async ({ run }) => {
      const fetch = scriptedFetch(json(403, { code: 'EMAIL_IS_NOT_VERIFIED', message: 'Denied.' }))
      await expect(run()).rejects.toMatchObject({ status: 403, code: 'EMAIL_IS_NOT_VERIFIED' })
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it.each(invitationAdapters)('forwards cancellation to $name', async ({ run, response }) => {
    const controller = new AbortController()
    const fetch = scriptedFetch(json(200, response))
    await run(controller.signal)
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

const INVITATION_NEXT = `/app/join?invitationId=${INVITATION.id}`
const INVITATION_REDIRECTS: SignInRedirects = {
  callbackURL: INVITATION_NEXT,
  errorCallbackURL: `/sign-in?next=${encodeURIComponent(INVITATION_NEXT)}`,
}
const signInAdapters = [
  {
    name: 'magic link',
    run: (redirects: SignInRedirects) => sendSignInLink('ada@example.com', redirects),
    path: '/api/auth/sign-in/magic-link',
    body: { email: 'ada@example.com' },
  },
  {
    name: 'Google',
    run: (redirects: SignInRedirects) => startSocialSignIn('google', redirects),
    path: '/api/auth/sign-in/social',
    body: { provider: 'google' },
  },
  {
    name: 'Microsoft',
    run: (redirects: SignInRedirects) => startSocialSignIn('microsoft', redirects),
    path: '/api/auth/sign-in/social',
    body: { provider: 'microsoft' },
  },
]

describe.each(signInAdapters)('$name sign-in callbacks', ({ run, path, body }) => {
  it('preserves the invitation in success and error callbacks', async () => {
    const fetch = scriptedFetch(json(200, { url: 'https://identity.example/authorize' }))
    await run(INVITATION_REDIRECTS)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, ...INVITATION_REDIRECTS }),
    })
  })

  it.each([
    'https://evil.example/app/join',
    '//evil.example/app/join',
    '/\\evil.example/app/join',
    '/app/../api/auth/sign-out',
    '/app/%2f%2fevil.example',
  ])('rejects unsafe success callback %s before requesting sign-in', async (callbackURL) => {
    const fetch = scriptedFetch()
    await expect(run({ callbackURL, errorCallbackURL: '/sign-in' })).rejects.toThrow(
      'Invalid sign-in callback path',
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    'https://evil.example/sign-in',
    '//evil.example/sign-in',
    '/\\evil.example/sign-in',
    '/sign-in?next=https%3A%2F%2Fevil.example',
    '/sign-in?next=%2F%2Fevil.example',
  ])('rejects unsafe error callback %s before requesting sign-in', async (errorCallbackURL) => {
    const fetch = scriptedFetch()
    await expect(run({ ...INVITATION_REDIRECTS, errorCallbackURL })).rejects.toThrow(
      'Invalid sign-in callback path',
    )
    expect(fetch).not.toHaveBeenCalled()
  })
})
