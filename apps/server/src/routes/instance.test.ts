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
  policies: Pick<Parameters<typeof instanceRoutes>[0], 'privacyPolicyUrl' | 'termsUrl'> = {},
) =>
  createApp({
    checkDb: async () => {},
    publicUrl,
    authHandler: async () => new Response(null, { status: 404 }),
    // Nobody is signed in: the route must not need anyone to be.
    resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
    routes: [instanceRoutes({ publicUrl, socialProviders, hostedSignupUrl, ...policies })],
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
      signIn: { email: true, google: true, microsoft: true },
    })
    expect(text).not.toMatch(/client/i)

    const googleOnly = await appWith({ google: oauth('google') }).request('/api/v1/instance')
    expect(await googleOnly.json()).toEqual({
      publicUrl,
      hostedSignupUrl: 'https://hourmere.com',
      automaticGoogleMeet: false,
      automaticZoom: false,
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
  })
})
