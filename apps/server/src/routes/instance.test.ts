import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, createPool } from '@hourmere/db'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { loadConfig } from '../config.ts'
import { productRoutes } from '../server.ts'
import { instanceRoutes } from './instance.ts'

const publicUrl = 'https://instance.example.com:8443'
const appWith = (
  socialProviders: Parameters<typeof instanceRoutes>[0]['socialProviders'],
  hostedSignupUrl?: string,
  options: Pick<
    Parameters<typeof instanceRoutes>[0],
    'privacyPolicyUrl' | 'termsUrl' | 'followUpHostNotesEnabled'
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
      '      automaticZoom,\n      followUpHostNotesEnabled,\n      hostedSignupUrl,',
      '      automaticZoom,\n      hostedSignupUrl,',
    ])
    await expect(verifyHostNoteCapability(copy.productRoutes)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it('detects a public response that hides the disabled host-note switch', async () => {
    const copy = await sourceCopy<typeof import('./instance.ts')>('./instance.ts', [
      '    followUpHostNotesEnabled,\n    signIn:',
      '    followUpHostNotesEnabled: true,\n    signIn:',
    ])
    await expect(verifyPublicHostNoteCapability(false, copy.instanceRoutes)).rejects.toMatchObject({
      name: 'AssertionError',
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
  })
})
