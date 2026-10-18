import { describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { instanceRoutes } from './instance.ts'

const appWith = (
  socialProviders: Parameters<typeof instanceRoutes>[0]['socialProviders'],
  hostedSignupUrl?: string,
) =>
  createApp({
    checkDb: async () => {},
    publicUrl: 'http://localhost:3000',
    authHandler: async () => new Response(null, { status: 404 }),
    // Nobody is signed in: the route must not need anyone to be.
    resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
    routes: [instanceRoutes({ socialProviders, hostedSignupUrl })],
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
      hostedSignupUrl: 'https://hourmere.com',
      automaticGoogleMeet: false,
      automaticZoom: false,
      signIn: { email: true, google: true, microsoft: true },
    })
    expect(text).not.toMatch(/client/i)

    const googleOnly = await appWith({ google: oauth('google') }).request('/api/v1/instance')
    expect(await googleOnly.json()).toEqual({
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
      hostedSignupUrl: 'https://hourmere.com',
      automaticGoogleMeet: false,
      automaticZoom: false,
      signIn: { email: true, google: false, microsoft: false },
    })
  })

  it('publishes the configured hosted sign-up destination without requiring a session', async () => {
    const res = await appWith({}, 'https://hosted.example/sign-up').request('/api/v1/instance')
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveProperty('hostedSignupUrl', 'https://hosted.example/sign-up')
  })

  it('is documented as a public route', async () => {
    const res = await appWith({}).request('/api/v1/openapi.json')
    const doc = (await res.json()) as {
      paths: Record<string, { get?: { security?: unknown; responses: Record<string, unknown> } }>
    }
    const operation = doc.paths['/api/v1/instance']?.get
    expect(operation).toBeDefined()
    expect(operation?.security).toBeUndefined()
    expect(Object.keys(operation?.responses ?? {})).toEqual(['200'])
  })
})
