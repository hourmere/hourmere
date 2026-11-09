import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createRoute, z } from '@hono/zod-openapi'
import { createDb, createPool } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
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

afterEach(() => vi.unstubAllEnvs())

function stubSsoEnvironment() {
  for (const name of ['SSO_OIDC_ENABLED', 'SSO_SAML_ENABLED', 'ssoOidcEnabled', 'ssoSamlEnabled']) {
    vi.stubEnv(name, 'true')
  }
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
      const unknown = await app.request('/api/v1/test-only-sso/known')
      expect(unknown.status).toBe(404)
      expect(await unknown.json()).toEqual({ error: 'not_found' })
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

it('detects direct process environment reads in instance responses', async () => {
  stubSsoEnvironment()
  const control = await sourceCopy<typeof import('./routes/instance.ts')>('./routes/instance.ts')
  await verifyInstance((options) => [control.instanceRoutes({ publicUrl, ...options })])
  const mutant = await sourceCopy<typeof import('./routes/instance.ts')>('./routes/instance.ts', [
    '    ssoOidcEnabled,',
    "    ssoOidcEnabled: process.env.SSO_OIDC_ENABLED === 'true',",
  ])
  await expect(
    verifyInstance((options) => [mutant.instanceRoutes({ publicUrl, ...options })]),
  ).rejects.toMatchObject({ name: 'AssertionError' })
})

it('detects a disabled test route accidentally registered in production', async () => {
  const control = await sourceCopy<typeof server>('./server.ts')
  await verifyInstance(control.productRoutes)
  const mutant = await sourceCopy<typeof server>('./server.ts', [
    'return [',
    `return [({ app }) => {
      app.get('/api/v1/test-only-sso/:id', (c) => c.json({ error: 'sso_disabled' }, 404))
    },`,
  ])
  await expect(verifyInstance(mutant.productRoutes)).rejects.toMatchObject({
    name: 'AssertionError',
  })
})

async function verifyGuard(guard = requireSsoEnabled, appFactory = createApp) {
  for (const ssoOidcEnabled of [false, true]) {
    for (const ssoSamlEnabled of [false, true]) {
      const flags: SsoCapabilities = { ssoOidcEnabled, ssoSamlEnabled }
      for (const protocol of [
        undefined,
        'oidc',
        'saml',
        '',
        'saml ',
        'SAML',
        ' oidc',
        'OIDC',
        'oauth',
        // Prototype keys: a lookup-table guard would resolve them to Object.prototype members.
        'constructor',
        '__proto__',
        'toString',
        'hasOwnProperty',
        null,
        false,
        0,
        {},
        // Arrays: repeated query keys and JSON bodies arrive this way; never protocol-neutral.
        ['oidc'],
        ['saml'],
        [],
      ] as const) {
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
              // Runtime callers can pass unvalidated input despite the TypeScript signature.
              guard(flags, protocol as Parameters<typeof guard>[1])
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
              : protocol === undefined && (ssoOidcEnabled || ssoSamlEnabled)
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
    ['protocol === undefined &&', 'true &&'],
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
    stubSsoEnvironment()
    // Re-evaluate the production module graph with the environment already set,
    // including reads captured at module scope rather than inside startServer.
    vi.resetModules()
    const [freshServer, freshApp, freshGuard] = await Promise.all([
      import('./server.ts'),
      import('./app.ts'),
      import('./sso.ts'),
    ])
    // Use the same fresh module graph for the guard and app's DomainError handler.
    await verifyGuard(freshGuard.requireSsoEnabled, freshApp.createApp)
    const owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'sso_off',
    })
    try {
      const running = await freshServer.startServer({
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
        const unknown = await fetch(`${origin}/api/v1/test-only-sso/known`)
        expect(unknown.status).toBe(404)
        expect(await unknown.json()).toEqual({ error: 'not_found' })
      } finally {
        await running.close()
      }
    } finally {
      await owned.drop()
    }
  }, 30_000)

  it('starts the real entry point with both settings on and still reports both off', async () => {
    // index.ts is the composition root production runs (`npm start`, the Docker CMD). Only a
    // child process executes it, so module-scope reads and any override it passes into
    // startServer are observed exactly as production would observe them.
    const owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'sso_entry',
    })
    // onTestFinished runs after an assertion failure, a thrown error and the test timeout
    // alike (a `finally` only covers the first two), in reverse order: the child is killed
    // first, then its database is dropped.
    onTestFinished(() => owned.drop())
    const env: NodeJS.ProcessEnv = {}
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'NODE_OPTIONS', 'HOURMERE_OUTBOX_DB_REGISTRY'])
      if (process.env[key]) env[key] = process.env[key]
    Object.assign(env, {
      DATABASE_URL: owned.url,
      BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
      PUBLIC_URL: 'http://localhost',
      PORT: '0',
      HOURMERE_ROLE: 'web',
      SIGNUP: 'closed',
      SSO_OIDC_ENABLED: 'true',
      SSO_SAML_ENABLED: 'true',
      ssoOidcEnabled: 'true',
      ssoSamlEnabled: 'true',
    })
    const child = spawn(process.execPath, [fileURLToPath(new URL('./index.ts', import.meta.url))], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const alive = () => child.exitCode === null && child.signalCode === null
    onTestFinished(async () => {
      // Whatever ended the test, no server process keeps listening on its port.
      if (alive()) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
    })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk
    })
    // Every wait has its own deadline, well inside the test's, so a stall fails with the
    // child's output instead of the bare timeout message.
    const port = await new Promise<number>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error(`entry point did not listen within 30 s:\n${output}`)),
        30_000,
      )
      const settle = (settlement: () => void) => {
        clearTimeout(deadline)
        settlement()
      }
      child.stdout.on('data', () => {
        const match = /Hourmere listening on :(\d+)/.exec(output)
        if (match) settle(() => resolve(Number(match[1])))
      })
      child.once('error', (err) => settle(() => reject(err)))
      child.once('exit', (code, signal) =>
        settle(() =>
          reject(new Error(`entry point exited (${code ?? signal}) before listening:\n${output}`)),
        ),
      )
    })
    const origin = `http://127.0.0.1:${port}`
    const response = await fetch(`${origin}/api/v1/instance`, {
      signal: AbortSignal.timeout(10_000),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ssoOidcEnabled: false,
      ssoSamlEnabled: false,
    })
    const unknown = await fetch(`${origin}/api/v1/test-only-sso/known`, {
      signal: AbortSignal.timeout(10_000),
    })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ error: 'not_found' })
    // index.ts owns shutdown too: SIGTERM must close the server and exit cleanly, promptly.
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(10_000) }).catch(
      (err: unknown) => {
        throw err instanceof Error && err.name === 'AbortError'
          ? new Error(`entry point did not exit within 10 s of SIGTERM:\n${output}`)
          : err
      },
    )
    child.kill('SIGTERM')
    const [code] = (await exited) as [number | null, NodeJS.Signals | null]
    expect(code, output).toBe(0)
  }, 60_000)
})
