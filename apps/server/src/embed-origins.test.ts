import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as embed from '@hourmere/core/embed'
import { explicitLanguage } from '@hourmere/core/language'
import { isPublicTeamSlug, isReservedName } from '@hourmere/core/reserved'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { APP_CSP } from './security-headers.ts'

const appOrigin = 'https://hourmere.example'
const allowedOrigin = 'https://embed-owner.example'
const attackerOrigin = 'https://embed-attacker.example'

/** Evaluate a real source copy; never rewrite the production module on disk. */
function sourceCopy(replacement: string): typeof embed.embedParent {
  const original = readFileSync('packages/core/src/embed.ts', 'utf8')
  const guard = 'return origin && allowedOrigins.includes(origin) ? origin : undefined'
  expect(original).toContain(guard)
  const modified = original.replace(guard, replacement)
  expect(modified).not.toBe(original)
  const source = stripTypeScriptTypes(modified)
    .replace(/^import .*\n/gm, '')
    .replace(/^export /gm, '')
  return new Function(
    'explicitLanguage',
    'isPublicTeamSlug',
    'isReservedName',
    `${source}\nreturn embedParent`,
  )(explicitLanguage, isPublicTeamSlug, isReservedName)
}

describe('embed parent origin HTTP contract', () => {
  let dist: string
  beforeAll(async () => {
    dist = await mkdtemp(join(tmpdir(), 'hourmere-embed-origins-'))
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>Embed booking</title>')
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => rm(dist, { recursive: true, force: true }))

  async function request(parentOrigin: string, embedOrigins = [allowedOrigin]) {
    const app = createApp({
      checkDb: async () => {},
      authHandler: async () => Response.json({}),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      publicUrl: appOrigin,
      webDist: dist,
      embedOrigins,
    })
    const query = new URLSearchParams({ parentOrigin, embedId: 'abcdefghijklmnop1234' })
    return app.request(`${appOrigin}/embed/ada/intro?${query}`)
  }

  async function refuses(parentOrigin: string) {
    const response = await request(parentOrigin)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'embedding_not_allowed' })
    expect(response.headers.get('X-Frame-Options')).toBe('DENY')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  }

  async function permits(parentOrigin: string) {
    const response = await request(parentOrigin, [parentOrigin])
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<title>Embed booking</title>')
    expect(response.headers.get('X-Frame-Options')).toBeNull()
    expect(response.headers.get('Content-Security-Policy')).toBe(
      APP_CSP.replace("frame-ancestors 'none'", `frame-ancestors ${parentOrigin}`),
    )
  }

  it('refuses an unlisted third-party parent independently of the app origin', async () => {
    expect(attackerOrigin).not.toBe(appOrigin)
    await refuses(attackerOrigin)
  })
  it('refuses the app own origin when it is not explicitly listed', async () => {
    await refuses(appOrigin)
  })
  it('permits the app own origin when it is explicitly listed', async () => {
    await permits(appOrigin)
  })
  it('permits an explicitly listed third-party parent', async () => {
    await permits(allowedOrigin)
  })

  it.each([
    {
      name: 'accept every origin',
      replacement: 'return origin',
      verify: () => refuses(attackerOrigin),
    },
    {
      name: 'refuse every origin',
      replacement: 'return undefined',
      verify: () => permits(allowedOrigin),
    },
  ])('detects $name with a real HTTP assertion failure', async ({ replacement, verify }) => {
    const check = vi.spyOn(embed, 'embedParent')
    check.mockImplementation(
      sourceCopy(
        'return origin && allowedOrigins.includes(origin) ? origin : undefined // baseline',
      ),
    )
    await verify()
    check.mockImplementation(sourceCopy(replacement))
    await expect(verify()).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
