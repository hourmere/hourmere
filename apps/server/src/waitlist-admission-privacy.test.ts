import '@hono/zod-openapi'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createRoute } from '@hono/zod-openapi'
import type { DomainError } from '@hourmere/scheduling'
import type { HTTPException } from 'hono/http-exception'
import { describe, expect, it, vi } from 'vitest'
import type { createApp } from './app.ts'
import { WaitlistJoinBody, WaitlistResendBody } from './routes/public.ts'

type AppCopy = {
  createApp: typeof createApp
  DomainError: typeof DomainError
  HTTPException: typeof HTTPException
}
type Replacement = readonly [string, string]
async function copy(replacement?: Replacement): Promise<AppCopy> {
  const moduleUrl = new URL('app.ts', import.meta.url)
  let source = readFileSync(moduleUrl, 'utf8')
  if (replacement) {
    expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
    source = source.replace(...replacement)
  }
  source = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('.') ? new URL(specifier, moduleUrl).href : specifier.startsWith('node:') ? specifier : import.meta.resolve(specifier)}'`,
  )
  source += '\nexport {DomainError,HTTPException};'
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}
const privateMarker = 'private-invitee@example.test private-name 2027-01-23T05:00:00Z'
const capability = `00000000-0000-4000-8000-000000000017.${'v'.repeat(43)}`
const input = {
  email: 'invitee@example.test',
  preferredWindow: { start: '2027-01-23T00:00:00Z', end: '2027-01-24T00:00:00Z', timeZone: 'UTC' },
  consent: true,
}
const paths = [
  '/api/v1/public/host/intro/waitlist',
  '/api/v1/public/teams/alpha/intro/waitlist',
  '/api/v1/public/ho%2Fst/intro/waitlist',
  '/api/v1/public/host/in%2Ftro/waitlist',
  '/api/v1/public/teams/al%2Fpha/intro/waitlist',
  '/api/v1/public/teams/alpha/in%2Ftro/waitlist',
]
function app(module: AppCopy, mode = 'validate') {
  return module.createApp({
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
    publicUrl: 'http://localhost',
    routes: [
      ({ app }) => {
        for (const base of [
          '/api/v1/public/{handle}/{slug}/waitlist',
          '/api/v1/public/teams/{handle}/{slug}/waitlist',
        ])
          for (const suffix of ['', '/resend'])
            app.openapi(
              createRoute({
                method: 'post',
                path: `${base}${suffix}`,
                request: {
                  body: {
                    required: true,
                    content: {
                      'application/json': {
                        schema: suffix ? WaitlistResendBody : WaitlistJoinBody,
                      },
                    },
                  },
                },
                responses: { 202: { description: 'Accepted' } },
              }),
              (c) => {
                if (mode === 'unexpected')
                  throw new Error(privateMarker, {
                    cause: { detail: privateMarker, parameters: [privateMarker] },
                  })
                if (mode === 'domain')
                  throw new module.DomainError('conflict', 'waitlist_unavailable', privateMarker, {
                    cause: new Error(privateMarker),
                  })
                if (mode === 'http') throw new module.HTTPException(400, { message: privateMarker })
                return c.json({ accepted: true }, 202)
              },
            )
      },
    ],
  })
}
async function request(a: ReturnType<typeof app>, path: string, body: unknown) {
  return a.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
async function assertValidation(module: AppCopy) {
  const a = app(module)
  for (const base of paths)
    for (const suffix of ['', '/resend']) {
      const body = suffix ? { email: input.email } : input
      for (const malformed of [
        { ...body, [privateMarker]: true },
        { ...body, [capability]: true },
        ...(!suffix
          ? [{ ...body, preferredWindow: { ...input.preferredWindow, [privateMarker]: true } }]
          : []),
      ]) {
        const response = await request(a, `${base}${suffix}`, malformed)
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'invalid_request' })
      }
    }
}
async function assertDiagnostics(module: AppCopy, mode: string) {
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ]
  try {
    const a = app(module, mode)
    for (const base of paths)
      for (const suffix of ['', '/resend']) {
        const response = await request(
          a,
          `${base}${suffix}`,
          suffix ? { email: input.email } : input,
        )
        expect(response.status).toBe(mode === 'unexpected' ? 500 : mode === 'domain' ? 409 : 400)
        expect(await response.json()).toEqual({
          error:
            mode === 'unexpected'
              ? 'internal_error'
              : mode === 'domain'
                ? 'waitlist_unavailable'
                : 'invalid_request',
        })
      }
    expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain(privateMarker)
    if (mode !== 'http') expect(spies[2]?.mock.calls).toHaveLength(paths.length * 2)
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
}

describe('waitlist admission input privacy', () => {
  it('keeps strict validation opaque for private unknown property names and nested window keys', async () => {
    await assertValidation(await copy())
  })
  it.each(['unexpected', 'domain', 'http'])(
    'keeps private %s details out of responses and diagnostics',
    async (mode) => {
      await assertDiagnostics(await copy(), mode)
    },
  )
  it('detects source-copy reflection of private validation keys', async () => {
    const module = await copy([
      "if (isWaitlistAdmissionPath(c.req.path)) return c.json({ error: 'invalid_request' }, 400)",
      '',
    ])
    await expect(assertValidation(module)).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects source-copy raw private diagnostics', async () => {
    const module = await copy([
      "isWaitlistAdmissionPath(c.req.path) || isWaitlistEntryPath(c.req.path)\n        ? 'private waitlist request failed'\n        : detail",
      'detail',
    ])
    await expect(assertDiagnostics(module, 'unexpected')).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })
  it.each(['message', 'detail'])('detects source-copy reflected private %s', async (field) => {
    const module = await copy(
      field === 'detail'
        ? ['if (isWaitlistAdmissionPath(c.req.path)) delete body.message', '']
        : [
            'err.message && !isOneTimeLinkPath(c.req.path) && !isWaitlistAdmissionPath(c.req.path)',
            'err.message && !isOneTimeLinkPath(c.req.path)',
          ],
    )
    await expect(
      assertDiagnostics(module, field === 'message' ? 'http' : 'domain'),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects source-copy loss of raw-path protection for encoded parameter slashes', async () => {
    const module = await copy([
      'return admission.test(path) || admission.test(decoded)',
      'return admission.test(decoded)',
    ])
    await expect(assertValidation(module)).rejects.toMatchObject({ name: 'AssertionError' })
  })
})

async function assertEntryDiagnostics(module: AppCopy, method: 'GET' | 'DELETE') {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const a = module.createApp({
      publicUrl: 'http://localhost',
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      routes: [
        ({ app }) => {
          app.on(method, '/api/v1/event-types/:id/waitlist/entries/:entryId?', () => {
            throw new Error(`Failing row contains (${privateMarker})`, {
              cause: { detail: privateMarker, parameters: [privateMarker] },
            })
          })
        },
      ],
    })
    const suffix = method === 'DELETE' ? '/00000000-0000-4000-8000-000000000017' : ''
    const response = await a.request(
      `/api/v1/event-types/00000000-0000-4000-8000-000000000018/waitlist/entries${suffix}`,
      { method },
    )
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'internal_error' })
    expect(log).toHaveBeenCalledOnce()
    const diagnostics = JSON.stringify(log.mock.calls)
    expect(diagnostics).toContain('private waitlist request failed')
    expect(diagnostics).not.toContain('private-invitee@example.test')
    expect(diagnostics).not.toContain('private-name')
  } finally {
    log.mockRestore()
  }
}

describe('waitlist management error privacy', () => {
  it.each(['GET', 'DELETE'] as const)(
    'redacts contacts from %s entry diagnostics',
    async (method) => {
      await assertEntryDiagnostics(await copy(), method)
    },
  )
  it.each(['GET', 'DELETE'] as const)(
    'kills source-copy removal of %s entry redaction',
    async (method) => {
      const module = await copy([' || isWaitlistEntryPath(c.req.path)', ''])
      await expect(assertEntryDiagnostics(module, method)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
  )
})
