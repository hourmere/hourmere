import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createRoute, z } from '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import { localeRegistry } from '@hourmere/core/locales'
import type { Db } from '@hourmere/db'
import { expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import * as openapi from '../openapi.ts'
import { openTimeSnippetRoutes } from './open-time-snippets.ts'

const principal: Principal = {
  kind: 'api_key',
  apiKeyScope: 'read',
  apiKeyId: randomUUID(),
  user: { id: randomUUID(), name: 'Host', email: 'host@example.test' },
  organization: { id: randomUUID(), name: 'Personal', slug: 'host', personal: true },
}
const input = {
  slug: 'chat',
  from: '2030-11-04T00:00:00Z',
  to: '2030-11-11T00:00:00Z',
  locale: 'zh-CN',
  displayTimeZone: 'Asia/Shanghai',
}
function copy(change?: [string, string]) {
  let source = readFileSync('apps/server/src/routes/open-time-snippets.ts', 'utf8')
  if (change) {
    expect(source).toContain(change[0])
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const service = vi.fn(async () => ({ text: 'available', html: '<p>available</p>' }))
  const bindings = { ...openapi, z, createRoute, localeRegistry, generateOpenTimeSnippet: service }
  const factory = new Function(...Object.keys(bindings), `${source}; return openTimeSnippetRoutes`)(
    ...Object.values(bindings),
  ) as typeof openTimeSnippetRoutes
  return { factory, service }
}
async function verify(change?: [string, string]) {
  const { factory, service } = copy(change)
  const db = {} as Db
  const deps = {
    db,
    publicUrl: 'https://example.test',
    slotSnippetsEnabled: true,
    automaticMeet: true,
    automaticZoom: true,
  }
  const app = createApp({
    publicUrl: deps.publicUrl,
    checkDb: async () => {},
    authHandler: async () => new Response(null),
    resolveCaller: async () => ({ ok: true, principal, setCookie: [] }),
    routes: [factory(deps)],
  })
  const response = await app.request('/api/v1/open-time-snippets', {
    method: 'POST',
    headers: { authorization: 'Bearer hm_test', 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ text: 'available', html: '<p>available</p>' })
  expect(service).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ db, principal, automaticMeet: true, automaticZoom: true }),
    input,
    deps,
  )
}
it('REST passes the authenticated principal and instance capabilities into the shared service', () =>
  verify())
it('checks source copies and kills lost caller context', async () => {
  await verify()
  await expect(
    verify(['serviceContext(deps, c.var.principal)', 'serviceContext(deps, undefined)']),
  ).rejects.toMatchObject({ name: 'AssertionError' })
})

it('REST honors the disabled instance flag before touching a database', async () => {
  const app = createApp({
    publicUrl: 'https://example.test',
    checkDb: async () => {},
    authHandler: async () => new Response(null),
    resolveCaller: async () => ({ ok: true, principal, setCookie: [] }),
    routes: [
      openTimeSnippetRoutes({
        db: {} as Db,
        publicUrl: 'https://example.test',
        slotSnippetsEnabled: false,
      }),
    ],
  })
  const response = await app.request('/api/v1/open-time-snippets', {
    method: 'POST',
    headers: { authorization: 'Bearer hm_test', 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ error: 'slot_snippets_disabled' })
})
it('kills lost automatic-conference capability propagation', async () => {
  await expect(
    verify([
      'serviceContext(deps, c.var.principal)',
      'serviceContext({ ...deps, automaticMeet: false, automaticZoom: false }, c.var.principal)',
    ]),
  ).rejects.toMatchObject({ name: 'AssertionError' })
})
