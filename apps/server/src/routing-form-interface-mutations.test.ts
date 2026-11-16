import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { Principal } from '@hourmere/auth'
import { createDb, createPool } from '@hourmere/db'
import { expect, it } from 'vitest'
import type { createApp } from './app.ts'
import type { routingFormRoutes } from './routes/routing-forms.ts'

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

const principal: Principal = {
  kind: 'api_key',
  apiKeyId: '00000000-0000-4000-8000-000000000001',
  apiKeyScope: 'read',
  user: {
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Routing mutation',
    email: 'routing-mutation@example.test',
  },
  organization: {
    id: '00000000-0000-4000-8000-000000000003',
    name: 'Routing mutation',
    slug: 'routing-mutation',
    personal: true,
  },
}

it('detects removing the disabled guard from the actual configuration routes', async () => {
  // Native copies share their middleware markers and DomainError constructors. The
  // source files remain untouched; the only mutant removes the adapter's guard wiring.
  const application = await sourceCopy<{ createApp: typeof createApp }>('./app.ts')
  const control = await sourceCopy<{ routingFormRoutes: typeof routingFormRoutes }>(
    './routes/routing-forms.ts',
  )
  const mutant = await sourceCopy<{ routingFormRoutes: typeof routingFormRoutes }>(
    './routes/routing-forms.ts',
    ['routingFormsGuard(deps.routingFormsEnabled),', ''],
  )
  // Neither the control nor mutant should reach storage: invalid reads stop at validation,
  // and the read credential cannot write. A lookup would fail against this closed port.
  const db = createDb(createPool('postgres://routing-mutation@127.0.0.1:9/routing-mutation'))
  try {
    const probe = async (routes: typeof routingFormRoutes) => {
      const app = application.createApp({
        publicUrl: 'http://localhost',
        checkDb: async () => {},
        authHandler: async () => new Response(null, { status: 404 }),
        resolveCaller: async () => ({ ok: true, principal, setCookie: [] }),
        routes: [routes({ db, routingFormsEnabled: false })],
      })
      const results = []
      for (const [method, path] of [
        ['GET', '/api/v1/routing-forms?limit=-1'],
        ['GET', '/api/v1/routing-forms/invalid'],
        ['POST', '/api/v1/routing-forms'],
        ['PATCH', '/api/v1/routing-forms/invalid'],
        ['DELETE', '/api/v1/routing-forms/invalid'],
      ] as const) {
        const response = await app.request(path, {
          method,
          headers: { authorization: 'Bearer hm_mutation', 'content-type': 'application/json' },
          ...(method === 'GET' ? {} : { body: '{}' }),
        })
        results.push({ status: response.status, body: await response.json() })
      }
      return results
    }
    const assertDisabled = (results: Awaited<ReturnType<typeof probe>>) => {
      expect(results).toHaveLength(5)
      for (const result of results)
        expect(result).toEqual({ status: 404, body: { error: 'routing_forms_disabled' } })
    }
    assertDisabled(await probe(control.routingFormRoutes))
    const mutated = await probe(mutant.routingFormRoutes)
    expect(mutated.map(({ status }) => status)).toEqual([400, 400, 403, 403, 403])
    expect(() => assertDisabled(mutated)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  } finally {
    await db.destroy()
  }
})
