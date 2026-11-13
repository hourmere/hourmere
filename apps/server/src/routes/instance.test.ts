import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { CallerResolver, Principal } from '@hourmere/auth'
import { createDb, createPool } from '@hourmere/db'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { loadConfig } from '../config.ts'
import { productRoutes } from '../server.ts'
import { instanceRoutes } from './instance.ts'

const publicUrl = 'https://instance.example.com:8443'
const host: Extract<Principal, { kind: 'session' }> = {
  kind: 'session',
  sessionId: '00000000-0000-4000-8000-000000000001',
  user: {
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Embed host',
    email: 'embed-host@example.test',
  },
  organization: {
    id: '00000000-0000-4000-8000-000000000003',
    name: 'Embed host',
    slug: 'embed-host',
    personal: true,
  },
}
const hostResolver: CallerResolver = async (headers) => {
  const authorization = headers.get('authorization')
  const principal: Principal | undefined =
    authorization === 'Bearer hm_embed_host'
      ? { ...host, kind: 'api_key', apiKeyId: host.sessionId, apiKeyScope: 'full' }
      : authorization === 'Bearer embed_oauth'
        ? {
            ...host,
            kind: 'oauth',
            oauthConsentId: host.sessionId,
            clientId: 'synthetic-embed-client',
            scopes: ['mcp:tools'],
          }
        : authorization === null && headers.get('cookie') === 'embed-host=valid'
          ? host
          : undefined
  return principal
    ? { ok: true, principal, setCookie: [] }
    : { ok: false, error: 'unauthorized', setCookie: [] }
}
const appWith = (
  socialProviders: Parameters<typeof instanceRoutes>[0]['socialProviders'],
  hostedSignupUrl?: string,
  options: Pick<
    Parameters<typeof instanceRoutes>[0],
    'privacyPolicyUrl' | 'termsUrl' | 'followUpHostNotesEnabled' | 'embedAllowedOrigins'
  > = {},
) =>
  createApp({
    checkDb: async () => {},
    publicUrl,
    authHandler: async () => new Response(null, { status: 404 }),
    // Nobody is signed in: the route must not need anyone to be.
    resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
    routes: [instanceRoutes({ publicUrl, socialProviders, hostedSignupUrl, ...options })],
  })

const oauth = (name: string) => ({
  clientId: `${name}-client-id`,
  clientSecret: `${name}-client-secret`,
})

describe('GET /api/v1/instance', () => {
  it('offers email sign-in only when no provider is configured', async () => {
    const res = await appWith({}).request('/api/v1/instance')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      publicUrl,
      hostedSignupUrl: 'https://hourmere.com',
      automaticGoogleMeet: false,
      automaticZoom: false,
      followUpHostNotesEnabled: true,
      slotSnippetsEnabled: false,
      scimProvisioningEnabled: false,
      ssoOidcEnabled: false,
      ssoSamlEnabled: false,
      routingFormsEnabled: false,
      workflowsEnabled: false,
      signIn: { email: true, google: false, microsoft: false },
    })
  })

  it('lists each configured provider, without any of its configuration', async () => {
    const both = appWith({ google: oauth('google'), microsoft: oauth('microsoft') })
    const res = await both.request('/api/v1/instance')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({
      publicUrl,
      hostedSignupUrl: 'https://hourmere.com',
      automaticGoogleMeet: false,
      automaticZoom: false,
      followUpHostNotesEnabled: true,
      slotSnippetsEnabled: false,
      scimProvisioningEnabled: false,
      ssoOidcEnabled: false,
      ssoSamlEnabled: false,
      routingFormsEnabled: false,
      workflowsEnabled: false,
      signIn: { email: true, google: true, microsoft: true },
    })
    expect(text).not.toMatch(/client/i)

    const googleOnly = await appWith({ google: oauth('google') }).request('/api/v1/instance')
    expect(await googleOnly.json()).toEqual({
      publicUrl,
      hostedSignupUrl: 'https://hourmere.com',
      automaticGoogleMeet: false,
      automaticZoom: false,
      followUpHostNotesEnabled: true,
      slotSnippetsEnabled: false,
      scimProvisioningEnabled: false,
      ssoOidcEnabled: false,
      ssoSamlEnabled: false,
      routingFormsEnabled: false,
      workflowsEnabled: false,
      signIn: { email: true, google: true, microsoft: false },
    })
  })

  it('answers the same with credentials, even bad ones', async () => {
    const res = await appWith({}).request('/api/v1/instance', {
      headers: { authorization: 'Bearer hm_unknown' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      publicUrl,
      hostedSignupUrl: 'https://hourmere.com',
      automaticGoogleMeet: false,
      automaticZoom: false,
      followUpHostNotesEnabled: true,
      slotSnippetsEnabled: false,
      scimProvisioningEnabled: false,
      ssoOidcEnabled: false,
      ssoSamlEnabled: false,
      routingFormsEnabled: false,
      workflowsEnabled: false,
      signIn: { email: true, google: false, microsoft: false },
    })
  })

  it('publishes PUBLIC_URL through the server route composition regardless of request host', async () => {
    // Route construction and this public response never connect to the database.
    const databaseUrl = 'postgres://instance-test@127.0.0.1:9/instance-test'
    const db = createDb(createPool(databaseUrl))
    try {
      const config = loadConfig({
        DATABASE_URL: databaseUrl,
        BETTER_AUTH_SECRET: 'instance-route-test-secret-at-least-32-characters',
        PUBLIC_URL: `${publicUrl}/`,
      })
      const app = createApp({
        checkDb: async () => {},
        publicUrl: config.PUBLIC_URL,
        authHandler: async () => new Response(null, { status: 404 }),
        resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
        routes: productRoutes({
          db,
          publicUrl: config.PUBLIC_URL,
          socialProviders: {},
          invitationMailLimits: { secret: 'instance-route-test-mail-secret' },
        }),
      })
      const res = await app.request('https://request-host.example/api/v1/instance', {
        headers: { host: 'host-header.example', 'x-forwarded-host': 'forwarded-host.example' },
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toHaveProperty('publicUrl', publicUrl)
    } finally {
      await db.destroy()
    }
  })

  it('publishes the configured hosted sign-up destination without requiring a session', async () => {
    const res = await appWith({}, 'https://hosted.example/sign-up').request('/api/v1/instance')
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveProperty('hostedSignupUrl', 'https://hosted.example/sign-up')
  })

  it('publishes operator policy links independently and without requiring a session', async () => {
    const privacyPolicyUrl = 'https://operator.example/privacy'
    const termsUrl = 'https://operator.example/terms'
    for (const policies of [{ privacyPolicyUrl }, { termsUrl }, { privacyPolicyUrl, termsUrl }]) {
      const app = appWith({}, undefined, policies)
      for (const headers of [{}, { authorization: 'Bearer hm_unknown' }]) {
        const res = await app.request('/api/v1/instance', { headers })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toMatchObject(policies)
        for (const key of ['privacyPolicyUrl', 'termsUrl'] as const)
          if (!(key in policies)) expect(body).not.toHaveProperty(key)
      }
    }
  })

  it('omits policy links when they are unset or empty', async () => {
    for (const policies of [{}, { privacyPolicyUrl: '', termsUrl: '' }]) {
      const res = await appWith({}, undefined, policies).request('/api/v1/instance')
      const body = await res.json()
      expect(body).not.toHaveProperty('privacyPolicyUrl')
      expect(body).not.toHaveProperty('termsUrl')
    }
  })

  async function verifyHostNoteCapability(factory: typeof productRoutes = productRoutes) {
    // No database connection is opened; route composition still owns and closes its pool.
    const databaseUrl = 'postgres://instance-test@127.0.0.1:9/instance-test'
    const db = createDb(createPool(databaseUrl))
    try {
      for (const configured of [undefined, 'true', 'false']) {
        const config = loadConfig({
          DATABASE_URL: databaseUrl,
          BETTER_AUTH_SECRET: 'instance-route-test-secret-at-least-32-characters',
          PUBLIC_URL: publicUrl,
          ...(configured && { FOLLOW_UP_HOST_NOTES_ENABLED: configured }),
        })
        const app = createApp({
          checkDb: async () => {},
          publicUrl,
          authHandler: async () => new Response(null, { status: 404 }),
          resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
          routes: factory({
            db,
            publicUrl,
            socialProviders: {},
            followUpHostNotesEnabled: config.FOLLOW_UP_HOST_NOTES_ENABLED,
            invitationMailLimits: { secret: 'instance-route-test-mail-secret' },
          }),
        })
        for (const headers of [{}, { authorization: 'Bearer hm_unknown' }]) {
          const response = await app.request('/api/v1/instance', { headers })
          expect(response.status).toBe(200)
          expect(await response.json()).toHaveProperty(
            'followUpHostNotesEnabled',
            configured !== 'false',
          )
        }
      }
    } finally {
      await db.destroy()
    }
  }

  async function verifyPublicHostNoteCapability(
    enabled: boolean,
    factory: typeof instanceRoutes = instanceRoutes,
  ) {
    const app = createApp({
      checkDb: async () => {},
      publicUrl,
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      routes: [factory({ publicUrl, socialProviders: {}, followUpHostNotesEnabled: enabled })],
    })
    const res = await app.request('/api/v1/instance')
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveProperty('followUpHostNotesEnabled', enabled)
  }

  it.each([true, false])('publishes the host-note capability when set to %s', async (enabled) => {
    await verifyPublicHostNoteCapability(enabled)
  })

  it('publishes the host-note operator switch through server route composition', async () => {
    await verifyHostNoteCapability()
  })

  async function verifyPublicEmbedCapability(
    embedAllowedOrigins: readonly string[] | undefined,
    factory: typeof instanceRoutes = instanceRoutes,
  ) {
    const app = createApp({
      checkDb: async () => {},
      publicUrl,
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: hostResolver,
      routes: [factory({ publicUrl, socialProviders: {}, embedAllowedOrigins })],
    })
    for (const headers of [
      {},
      { authorization: 'Bearer hm_unknown' },
      { cookie: 'embed-host=valid' },
    ]) {
      const response = await app.request('/api/v1/instance', { headers })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).not.toHaveProperty('embedAllowedOrigins')
      for (const origin of embedAllowedOrigins ?? [])
        expect(JSON.stringify(body).includes(origin)).toBe(false)
      if (embedAllowedOrigins === undefined) expect(body).not.toHaveProperty('embedEnabled')
      else expect(body).toHaveProperty('embedEnabled', embedAllowedOrigins.length > 0)
    }
  }

  it.each([
    ['unknown', undefined],
    ['disabled', []],
    ['configured', ['https://www.example.com', 'http://localhost:4173']],
  ] as const)(
    'publishes only %s embed readiness without exposing approved origins',
    async (_, origins) => {
      await verifyPublicEmbedCapability(origins)
    },
  )

  async function verifyEmbedCapabilityWiring(factory: typeof productRoutes = productRoutes) {
    const databaseUrl = 'postgres://instance-test@127.0.0.1:9/instance-test'
    const db = createDb(createPool(databaseUrl))
    try {
      for (const configured of [
        undefined,
        '',
        'https://WWW.example.com:443, https://blog.example.com',
      ]) {
        const config = loadConfig({
          DATABASE_URL: databaseUrl,
          BETTER_AUTH_SECRET: 'instance-route-test-secret-at-least-32-characters',
          PUBLIC_URL: publicUrl,
          EMBED_ALLOWED_ORIGINS: configured,
        })
        const app = createApp({
          checkDb: async () => {},
          publicUrl,
          authHandler: async () => new Response(null, { status: 404 }),
          resolveCaller: hostResolver,
          routes: factory({
            db,
            publicUrl,
            socialProviders: {},
            embedAllowedOrigins: config.EMBED_ALLOWED_ORIGINS,
            invitationMailLimits: { secret: 'instance-route-test-mail-secret' },
          }),
        })
        const response = await app.request('/api/v1/instance')
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body).toHaveProperty('embedEnabled', Boolean(configured))
        expect(body).not.toHaveProperty('embedAllowedOrigins')
        const privateResponse = await app.request('/api/v1/instance/embed', {
          headers: { cookie: 'embed-host=valid' },
        })
        expect(privateResponse.status).toBe(200)
        expect(await privateResponse.json()).toEqual({
          publicUrl,
          embedAllowedOrigins: configured
            ? ['https://www.example.com', 'https://blog.example.com']
            : [],
        })
      }
    } finally {
      await db.destroy()
    }
  }

  it('keeps normalized embed origins private through server route composition', async () => {
    await verifyEmbedCapabilityWiring()
  })

  function privateEmbedApp(
    origins: readonly string[] | undefined,
    factory: typeof instanceRoutes = instanceRoutes,
  ) {
    return createApp({
      checkDb: async () => {},
      publicUrl,
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: hostResolver,
      routes: [factory({ publicUrl, socialProviders: {}, embedAllowedOrigins: origins })],
    })
  }

  async function verifyPrivateEmbedCapability(
    origins: readonly string[] | undefined,
    factory: typeof instanceRoutes = instanceRoutes,
  ) {
    const response = await privateEmbedApp(origins, factory).request(
      'https://request-host.example/api/v1/instance/embed',
      {
        headers: {
          cookie: 'embed-host=valid',
          host: 'host-header.example',
          'x-forwarded-host': 'forwarded-host.example',
        },
      },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('vary')).toBe('Cookie, Authorization')
    expect(await response.json()).toEqual({
      publicUrl,
      ...(origins !== undefined && { embedAllowedOrigins: [...origins] }),
    })
  }

  async function verifyPrivateEmbedDenial(
    headers: Record<string, string>,
    expectedStatus: number,
    factory: typeof instanceRoutes = instanceRoutes,
  ) {
    const origin = 'https://unannounced-staging.example.test'
    const response = await privateEmbedApp([origin], factory).request('/api/v1/instance/embed', {
      headers,
    })
    expect(response.status).toBe(expectedStatus)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const body = await response.text()
    expect(body).not.toContain(origin)
    expect(body.includes('embedAllowedOrigins')).toBe(false)
  }

  it.each([
    ['unknown', undefined],
    ['disabled', []],
    ['configured', ['https://www.example.com', 'http://localhost:4173']],
  ] as const)('shows %s embed configuration only to the signed-in host', async (_, origins) => {
    await verifyPrivateEmbedCapability(origins)
  })

  it('denies anonymous, invalid-session, API-key and OAuth configuration reads', async () => {
    await verifyPrivateEmbedDenial({}, 401)
    await verifyPrivateEmbedDenial({ cookie: 'embed-host=invalid' }, 401)
    for (const authorization of ['Bearer hm_embed_host', 'Bearer embed_oauth']) {
      await verifyPrivateEmbedDenial({ authorization }, 403)
      await verifyPrivateEmbedDenial({ authorization, cookie: 'embed-host=valid' }, 403)
    }
    for (const authorization of ['', 'Basic synthetic', 'Bearer invalid'])
      await verifyPrivateEmbedDenial({ authorization, cookie: 'embed-host=valid' }, 401)
  })

  async function sourceCopy<T>(file: string, replacement?: [string, string]): Promise<T> {
    const location = new URL(file, import.meta.url)
    let source = readFileSync(location, 'utf8')
    if (replacement) {
      expect(source.includes(replacement[0]), 'mutation matches the capability protection').toBe(
        true,
      )
      source = source.replace(...replacement)
    }
    const javascript = stripTypeScriptTypes(source).replace(
      /((?:from|import)\s*)'([^']+)'/g,
      (_, prefix: string, specifier: string) => {
        const resolved = specifier.startsWith('.')
          ? new URL(specifier, location).href
          : import.meta.resolve(specifier)
        return `${prefix}'${resolved}'`
      },
    )
    return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
  }

  it('passes the public switch assertions with an unmodified isolated source copy', async () => {
    const copy = await sourceCopy<typeof import('../server.ts')>('../server.ts')
    await verifyHostNoteCapability(copy.productRoutes)
    const publicCopy = await sourceCopy<typeof import('./instance.ts')>('./instance.ts')
    await verifyPublicHostNoteCapability(false, publicCopy.instanceRoutes)
  })

  it('detects removing host-note capability wiring from the product routes', async () => {
    const copy = await sourceCopy<typeof import('../server.ts')>('../server.ts', [
      '      automaticZoom,\n      followUpHostNotesEnabled,\n      slotSnippetsEnabled,\n      hostedSignupUrl,',
      '      automaticZoom,\n      slotSnippetsEnabled,\n      hostedSignupUrl,',
    ])
    await expect(verifyHostNoteCapability(copy.productRoutes)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it('detects a public response that hides the disabled host-note switch', async () => {
    const copy = await sourceCopy<typeof import('./instance.ts')>('./instance.ts', [
      '    followUpHostNotesEnabled,\n',
      '    followUpHostNotesEnabled: true,\n',
    ])
    await expect(verifyPublicHostNoteCapability(false, copy.instanceRoutes)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it('passes embed readiness assertions with unmodified isolated source copies', async () => {
    const publicCopy = await sourceCopy<typeof import('./instance.ts')>('./instance.ts')
    await verifyPublicEmbedCapability(undefined, publicCopy.instanceRoutes)
    await verifyPublicEmbedCapability([], publicCopy.instanceRoutes)
    await verifyPublicEmbedCapability(['https://www.example.com'], publicCopy.instanceRoutes)
    for (const origins of [undefined, [], ['https://www.example.com']])
      await verifyPrivateEmbedCapability(origins, publicCopy.instanceRoutes)
    await verifyPrivateEmbedDenial({}, 401, publicCopy.instanceRoutes)
    await verifyPrivateEmbedDenial(
      { authorization: 'Bearer hm_embed_host' },
      403,
      publicCopy.instanceRoutes,
    )
    const serverCopy = await sourceCopy<typeof import('../server.ts')>('../server.ts')
    await verifyEmbedCapabilityWiring(serverCopy.productRoutes)
  })

  it('detects exposing approved origins through public instance discovery', async () => {
    const copy = await sourceCopy<typeof import('./instance.ts')>('./instance.ts', [
      '...(embedAllowedOrigins !== undefined && { embedEnabled: embedAllowedOrigins.length > 0 })',
      '...(embedAllowedOrigins !== undefined && { embedEnabled: embedAllowedOrigins.length > 0, embedAllowedOrigins: [...embedAllowedOrigins] })',
    ])
    await expect(
      verifyPublicEmbedCapability(
        ['https://unannounced-staging.example.test'],
        copy.instanceRoutes,
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects removing authentication from the private embed configuration', async () => {
    const copy = await sourceCopy<typeof import('./instance.ts')>('./instance.ts', [
      'middleware: [privateHeaders, caller, sessionOnly]',
      'middleware: [privateHeaders]',
    ])
    await expect(verifyPrivateEmbedDenial({}, 401, copy.instanceRoutes)).rejects.toMatchObject({
      name: 'AssertionError',
      actual: 200,
      expected: 401,
    })
  })

  it('detects allowing API keys to enumerate private embed origins', async () => {
    const copy = await sourceCopy<typeof import('./instance.ts')>('./instance.ts', [
      'middleware: [privateHeaders, caller, sessionOnly]',
      'middleware: [privateHeaders, caller]',
    ])
    await expect(
      verifyPrivateEmbedDenial({ authorization: 'Bearer hm_embed_host' }, 403, copy.instanceRoutes),
    ).rejects.toMatchObject({ name: 'AssertionError', actual: 200, expected: 403 })
  })

  it('detects a cacheable private embed configuration', async () => {
    const copy = await sourceCopy<typeof import('./instance.ts')>('./instance.ts', [
      "c.header('Cache-Control', 'private, no-store')",
      "c.header('Cache-Control', 'public, max-age=60')",
    ])
    await expect(
      verifyPrivateEmbedCapability(['https://www.example.com'], copy.instanceRoutes),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects losing private configuration credential variance', async () => {
    const copy = await sourceCopy<typeof import('./instance.ts')>('./instance.ts', [
      "c.header('Vary', 'Cookie, Authorization')",
      "c.header('Vary', 'Accept')",
    ])
    await expect(
      verifyPrivateEmbedCapability(['https://www.example.com'], copy.instanceRoutes),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects classifying unknown private embed configuration as disabled', async () => {
    const copy = await sourceCopy<typeof import('./instance.ts')>('./instance.ts', [
      '  embedAllowedOrigins,\n',
      '  embedAllowedOrigins = [],\n',
    ])
    await expect(
      verifyPrivateEmbedCapability(undefined, copy.instanceRoutes),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects omitting known disabled private embed configuration', async () => {
    const copy = await sourceCopy<typeof import('./instance.ts')>('./instance.ts', [
      '...(embedAllowedOrigins !== undefined && { embedAllowedOrigins: [...embedAllowedOrigins] })',
      '...(embedAllowedOrigins?.length && { embedAllowedOrigins: [...embedAllowedOrigins] })',
    ])
    await expect(verifyPrivateEmbedCapability([], copy.instanceRoutes)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it('detects classifying unknown embed readiness as disabled', async () => {
    const copy = await sourceCopy<typeof import('./instance.ts')>('./instance.ts', [
      '  embedAllowedOrigins,\n',
      '  embedAllowedOrigins = [],\n',
    ])
    await expect(verifyPublicEmbedCapability(undefined, copy.instanceRoutes)).rejects.toMatchObject(
      {
        name: 'AssertionError',
        message: expect.stringContaining('embedEnabled'),
      },
    )
  })

  it('detects hiding known disabled embed readiness', async () => {
    const copy = await sourceCopy<typeof import('./instance.ts')>('./instance.ts', [
      '...(embedAllowedOrigins !== undefined && { embedEnabled: embedAllowedOrigins.length > 0 })',
      '...(embedAllowedOrigins?.length && { embedEnabled: true })',
    ])
    await expect(verifyPublicEmbedCapability([], copy.instanceRoutes)).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('embedEnabled'),
    })
  })

  it('detects removing configured embed origins from product route wiring', async () => {
    const copy = await sourceCopy<typeof import('../server.ts')>('../server.ts', [
      '      hostedSignupUrl,\n      embedAllowedOrigins,\n',
      '      hostedSignupUrl,\n',
    ])
    await expect(verifyEmbedCapabilityWiring(copy.productRoutes)).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('embedEnabled'),
    })
  })

  it('is documented as a public route', async () => {
    const res = await appWith({}).request('/api/v1/openapi.json')
    const doc = (await res.json()) as {
      paths: Record<string, { get?: { security?: unknown; responses: Record<string, unknown> } }>
      components: {
        schemas: Record<string, { properties: Record<string, unknown>; required: string[] }>
      }
    }
    const operation = doc.paths['/api/v1/instance']?.get
    expect(operation).toBeDefined()
    expect(operation?.security).toBeUndefined()
    expect(Object.keys(operation?.responses ?? {})).toEqual(['200'])
    const instance = doc.components.schemas.Instance
    expect(instance?.properties).toHaveProperty('publicUrl', {
      type: 'string',
      format: 'uri',
      description: 'The public origin of this instance, configured by its operator',
    })
    expect(instance?.required).toContain('publicUrl')
    expect(instance?.properties).toHaveProperty('privacyPolicyUrl')
    expect(instance?.properties).toHaveProperty('termsUrl')
    expect(instance?.required).not.toContain('privacyPolicyUrl')
    expect(instance?.required).not.toContain('termsUrl')
    expect(instance?.properties).toHaveProperty('followUpHostNotesEnabled', {
      type: 'boolean',
      description: 'Whether hosts may add plain-text notes to follow-up emails',
    })
    expect(instance?.required).not.toContain('followUpHostNotesEnabled')
    expect(instance?.properties).toHaveProperty('embedEnabled', {
      type: 'boolean',
      description: 'Whether embedding is enabled; absent when unknown',
    })
    expect(instance?.required).not.toContain('embedEnabled')
    expect(instance?.properties).not.toHaveProperty('embedAllowedOrigins')
    const embedOperation = doc.paths['/api/v1/instance/embed']?.get
    expect(embedOperation?.security).toEqual([{ session: [] }])
    expect(Object.keys(embedOperation?.responses ?? {})).toEqual(['200', '401', '403', '429'])
    const configuration = doc.components.schemas.EmbedConfiguration
    expect(configuration?.properties).toHaveProperty('embedAllowedOrigins', {
      type: 'array',
      items: { type: 'string', format: 'uri' },
      maxItems: 32,
      description:
        'Exact website origins approved for embedding; empty when disabled, absent when unknown',
    })
    expect(configuration?.required).not.toContain('embedAllowedOrigins')
  })
})
