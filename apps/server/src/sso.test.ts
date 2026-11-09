import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createRoute, z } from '@hono/zod-openapi'
import { createDb, createPool } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { json, type RouteModule } from './openapi.ts'
import * as server from './server.ts'
import { requireSsoEnabled, type SsoCapabilities } from './sso.ts'

async function sourceCopy<T>(file: string, mutation?: [string, string]): Promise<T> {
  const location = new URL(file, import.meta.url)
  let source = readFileSync(location, 'utf8')
  if (mutation) {
    expect(source.includes(mutation[0])).toBe(true)
    source = source.replace(...mutation)
  }
  const javascript = stripTypeScriptTypes(source).replace(
    /((?:from|import)\s*)'([^']+)'/g,
    (_, prefix: string, specifier: string) =>
      `${prefix}'${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
}

const publicUrl = 'https://sso-test.example'
const base = {
  publicUrl,
  checkDb: async () => {},
  authHandler: async () => new Response(null, { status: 404 }),
  resolveCaller: async () => ({
    ok: false as const,
    error: 'unauthorized' as const,
    setCookie: [],
  }),
}

async function verifyInstance(factory = server.productRoutes) {
  const db = createDb(createPool('postgres://synthetic@127.0.0.1:9/sso-test'))
  try {
    for (const flags of [
      undefined,
      { ssoOidcEnabled: false, ssoSamlEnabled: false },
      { ssoOidcEnabled: true, ssoSamlEnabled: false },
      { ssoOidcEnabled: false, ssoSamlEnabled: true },
      { ssoOidcEnabled: true, ssoSamlEnabled: true },
    ]) {
      const app = createApp({
        ...base,
        routes: factory({
          db,
          socialProviders: {},
          invitationMailLimits: { secret: 'synthetic-sso-test-only-secret' },
          ...flags,
        }),
      })
      const response = await app.request(
        '/api/v1/instance?ssoOidcEnabled=true&ssoSamlEnabled=true&SSO_OIDC_ENABLED=true&SSO_SAML_ENABLED=true',
        { headers: { 'x-sso-oidc-enabled': 'true', 'x-sso-saml-enabled': 'true' } },
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject(
        flags ?? { ssoOidcEnabled: false, ssoSamlEnabled: false },
      )
      expect((await app.request('/api/v1/test-only-sso/known')).status).toBe(404)
    }
  } finally {
    await db.destroy()
  }
}

it('keeps production composition off and accepts only internal test injection', async () => {
  await verifyInstance()
})

it.each(['ssoOidcEnabled', 'ssoSamlEnabled'])(
  'detects flipping the %s production constant with real instance responses',
  async (name) => {
    const control = await sourceCopy<typeof server>('./server.ts')
    await verifyInstance(control.productRoutes)
    const mutant = await sourceCopy<typeof server>('./server.ts', [
      `const ${name} = false`,
      `const ${name} = true`,
    ])
    await expect(verifyInstance(mutant.productRoutes)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  },
)

async function verifyGuard(guard = requireSsoEnabled, appFactory = createApp) {
  for (const ssoOidcEnabled of [false, true]) {
    for (const ssoSamlEnabled of [false, true]) {
      const flags: SsoCapabilities = { ssoOidcEnabled, ssoSamlEnabled }
      for (const protocol of [undefined, 'oidc', 'saml'] as const) {
        const effects = vi.fn()
        // This route is deliberately defined only in the test, never in productRoutes.
        const route: RouteModule = ({ app }) => {
          app.openapi(
            createRoute({
              method: 'get',
              path: '/api/v1/test-only-sso/{id}',
              responses: {
                200: { description: 'Reached', content: json(z.object({ ok: z.boolean() })) },
              },
            }),
            (c) => {
              guard(flags, protocol)
              effects() // Stands for lookup, rate-limit counting and writes, all after the guard.
              return c.json({ ok: true }, 200)
            },
          )
        }
        const app = appFactory({ ...base, routes: [route] })
        const enabled =
          protocol === 'oidc'
            ? ssoOidcEnabled
            : protocol === 'saml'
              ? ssoSamlEnabled
              : ssoOidcEnabled || ssoSamlEnabled
        for (const id of ['known', 'unknown']) {
          const response = await app.request(`/api/v1/test-only-sso/${id}`)
          expect(response.status).toBe(enabled ? 200 : 404)
          expect(await response.json()).toEqual(enabled ? { ok: true } : { error: 'sso_disabled' })
        }
        expect(effects).toHaveBeenCalledTimes(enabled ? 2 : 0)
      }
    }
  }
}

it('guards both protocols and neutral operations before effects, for known and unknown IDs', async () => {
  await verifyGuard()
})

it('detects guard bypass and protocol cross-enablement using real HTTP assertions', async () => {
  // Native source copies must share their DomainError class with the native app copy.
  const nativeApp = await sourceCopy<typeof import('./app.ts')>('./app.ts')
  const control = await sourceCopy<typeof import('./sso.ts')>('./sso.ts')
  await verifyGuard(control.requireSsoEnabled, nativeApp.createApp)
  for (const mutation of [
    ["throw new DomainError('not_found', 'sso_disabled')", 'return'],
    ['? capabilities.ssoOidcEnabled', '? capabilities.ssoSamlEnabled'],
    ['? capabilities.ssoSamlEnabled', '? capabilities.ssoOidcEnabled'],
    [
      'capabilities.ssoOidcEnabled || capabilities.ssoSamlEnabled',
      'capabilities.ssoOidcEnabled && capabilities.ssoSamlEnabled',
    ],
  ] as [string, string][]) {
    const mutant = await sourceCopy<typeof import('./sso.ts')>('./sso.ts', mutation)
    await expect(verifyGuard(mutant.requireSsoEnabled, nativeApp.createApp)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  }
})

describe.skipIf(!process.env.DATABASE_URL)('production SSO hard-off startup', () => {
  it('ignores environment settings and never exposes the test route', async () => {
    const owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'sso_off',
    })
    try {
      const running = await server.startServer({
        DATABASE_URL: owned.url,
        BETTER_AUTH_SECRET: 'synthetic-sso-startup-secret-at-least-32-characters',
        PUBLIC_URL: 'http://localhost',
        PORT: '0',
        HOURMERE_ROLE: 'web',
        SSO_OIDC_ENABLED: 'true',
        SSO_SAML_ENABLED: 'true',
        ssoOidcEnabled: 'true',
        ssoSamlEnabled: 'true',
      })
      try {
        const origin = `http://127.0.0.1:${running.port}`
        const response = await fetch(`${origin}/api/v1/instance`)
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          ssoOidcEnabled: false,
          ssoSamlEnabled: false,
        })
        expect((await fetch(`${origin}/api/v1/test-only-sso/known`)).status).toBe(404)
      } finally {
        await running.close()
      }
    } finally {
      await owned.drop()
    }
  })
})
