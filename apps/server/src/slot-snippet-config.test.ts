import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, createPool } from '@hourmere/db'
import { expect, it } from 'vitest'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { instanceRoutes } from './routes/instance.ts'
import { productRoutes } from './server.ts'

const base = {
  DATABASE_URL: 'postgres://slot-config@127.0.0.1:9/slot-config',
  BETTER_AUTH_SECRET: 'synthetic-slot-config-secret-at-least-32-characters',
}

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

async function verifySwitch(factory = productRoutes) {
  const db = createDb(createPool(base.DATABASE_URL))
  try {
    for (const enabled of [undefined, false, true]) {
      const app = createApp({
        publicUrl: 'https://canonical.example',
        checkDb: async () => {},
        authHandler: async () => new Response(null, { status: 404 }),
        resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
        routes: factory({
          db,
          socialProviders: {},
          publicUrl: 'https://canonical.example',
          invitationMailLimits: { secret: 'synthetic-slot-config-mail-secret' },
          ...(enabled !== undefined && { slotSnippetsEnabled: enabled }),
        }),
      })
      const response = await app.request('https://untrusted.example/api/v1/instance')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { slotSnippetsEnabled: boolean; publicUrl: string }
      expect(body.slotSnippetsEnabled).toBe(enabled === true)
      expect(body.publicUrl).toBe('https://canonical.example')
    }
  } finally {
    await db.destroy()
  }
}

it('defaults snippets off and enables only the explicit operator opt-in', async () => {
  expect(loadConfig(base).SLOT_SNIPPETS_ENABLED).toBe(false)
  expect(loadConfig({ ...base, SLOT_SNIPPETS_ENABLED: 'false' }).SLOT_SNIPPETS_ENABLED).toBe(false)
  expect(loadConfig({ ...base, SLOT_SNIPPETS_ENABLED: 'true' }).SLOT_SNIPPETS_ENABLED).toBe(true)
  expect(() => loadConfig({ ...base, SLOT_SNIPPETS_ENABLED: 'yes' })).toThrow()
  await verifySwitch()
})

it('checks unmodified source copies and detects removing the release gate wiring', async () => {
  const control = await sourceCopy<typeof import('./server.ts')>('./server.ts')
  await verifySwitch(control.productRoutes)
  const mutant = await sourceCopy<typeof import('./server.ts')>('./server.ts', [
    '      slotSnippetsEnabled,\n      hostedSignupUrl,',
    '      hostedSignupUrl,',
  ])
  await expect(verifySwitch(mutant.productRoutes)).rejects.toMatchObject({ name: 'AssertionError' })
})

it('detects default-on configuration and public capabilities', async () => {
  const config = await sourceCopy<typeof import('./config.ts')>('./config.ts', [
    "(value) => value === 'true',\n    ),\n    FOLLOW_UP_HOST_NOTES_ENABLED:",
    "(value) => value !== 'false',\n    ),\n    FOLLOW_UP_HOST_NOTES_ENABLED:",
  ])
  expect(() => expect(config.loadConfig(base).SLOT_SNIPPETS_ENABLED).toBe(false)).toThrowError(
    expect.objectContaining({ name: 'AssertionError' }),
  )
  const control = await sourceCopy<typeof import('./routes/instance.ts')>('./routes/instance.ts')
  const mutant = await sourceCopy<typeof import('./routes/instance.ts')>('./routes/instance.ts', [
    '  slotSnippetsEnabled = false,',
    '  slotSnippetsEnabled = true,',
  ])
  async function verifyPublic(factory: typeof instanceRoutes) {
    const app = createApp({
      publicUrl: 'https://canonical.example',
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      routes: [factory({ publicUrl: 'https://canonical.example', socialProviders: {} })],
    })
    const response = await app.request('/api/v1/instance')
    expect(await response.json()).toHaveProperty('slotSnippetsEnabled', false)
  }
  await verifyPublic(instanceRoutes)
  await verifyPublic(control.instanceRoutes)
  await expect(verifyPublic(mutant.instanceRoutes)).rejects.toMatchObject({
    name: 'AssertionError',
  })
})
