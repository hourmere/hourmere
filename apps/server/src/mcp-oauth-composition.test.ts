import { randomBytes } from 'node:crypto'
import { type IncomingHttpHeaders, request } from 'node:http'
import { createServer } from 'node:net'
import { createTestDatabase } from '@hourmere/db/testing'
import { describe, expect, it, vi } from 'vitest'
import { type RunningServer, startServer } from './server.ts'

const serverUrl = process.env.DATABASE_URL
const port = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address() as { port: number }
      probe.close(() => resolve(address.port))
    })
  })

/**
 * A browser navigation, over node:http: fetch adds `sec-fetch-mode: cors`, on which Better
 * Auth answers 200 JSON instead of the 302 a browser gets, and that redirect is what the
 * authorize boundary must intercept.
 */
function navigate(url: string, form?: URLSearchParams) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const req = request(
        url,
        {
          method: form ? 'POST' : 'GET',
          agent: false,
          headers: {
            accept: 'text/html,application/xhtml+xml',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-dest': 'document',
            ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          },
        },
        (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            body += chunk
          })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
        },
      )
      req.on('error', reject)
      req.end(form?.toString())
    },
  )
}

describe.skipIf(!serverUrl)('MCP OAuth authorize boundary in the real composition', () => {
  it('guards the provider authorize endpoint exactly when MCP_OAUTH_ENABLED is true', async () => {
    const owned = await createTestDatabase(serverUrl as string)
    const spies = (['log', 'info', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    let running: RunningServer | undefined
    try {
      for (const enabled of ['true', 'false']) {
        const webPort = await port()
        const publicUrl = `http://localhost:${webPort}`
        running = await startServer({
          DATABASE_URL: owned.url,
          BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
          SIGNUP: 'closed',
          HOURMERE_ROLE: 'web',
          MCP_OAUTH_ENABLED: enabled,
          PORT: String(webPort),
          PUBLIC_URL: publicUrl,
        })
        const base = `http://127.0.0.1:${running.port}`
        const authorize = `${base}/api/auth/oauth2/authorize`
        // Not an authorization code request, and for a redirect URI nobody registered.
        const malformed = new URLSearchParams({
          client_id: 'any',
          redirect_uri: 'https://attacker.test/landing',
          response_type: 'token',
          scope: 'mcp:tools',
        })
        if (enabled === 'true') {
          const registered = await fetch(`${base}/api/auth/oauth2/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              client_name: 'Composition connector',
              redirect_uris: ['https://connector.test/callback'],
              grant_types: ['authorization_code', 'refresh_token'],
              response_types: ['code'],
              token_endpoint_auth_method: 'none',
            }),
          })
          expect(registered.status).toBe(201)
          const { client_id } = (await registered.json()) as { client_id: string }
          // A well-formed request without a session continues to Hourmere's own page.
          const valid = new URLSearchParams({
            client_id,
            redirect_uri: 'https://connector.test/callback',
            response_type: 'code',
            scope: 'mcp:tools offline_access',
            resource: `${publicUrl}/mcp`,
            code_challenge: 'A'.repeat(43),
            code_challenge_method: 'S256',
            state: 'composition',
          })
          const continued = await navigate(`${authorize}?${valid}`)
          expect(continued.status).toBe(302)
          const location = new URL(continued.headers.location as string, publicUrl)
          expect(location.origin).toBe(publicUrl)
          expect(location.pathname).toBe('/oauth/authorize')
          // A malformed one, as GET and as POST, is refused here and never redirected.
          for (const form of [undefined, malformed]) {
            const refused = await navigate(form ? authorize : `${authorize}?${malformed}`, form)
            expect(refused.status).toBe(400)
            expect(refused.headers['content-type']).toContain('text/html')
            expect(refused.headers.location).toBeUndefined()
            expect(refused.body).toContain('Unable to connect to Hourmere')
          }
          // Three requests so far; the 30-per-minute allowance counts them all.
          for (let count = 3; count < 30; count++)
            expect((await navigate(`${authorize}?${malformed}`)).status).toBe(400)
          const limited = await navigate(`${authorize}?${malformed}`)
          expect(limited.status).toBe(429)
          expect(limited.headers.location).toBeUndefined()
        } else {
          // Without OAuth the provider has no authorize endpoint, and nothing is mounted
          // in front of it: a browser gets the provider's own 404, however often.
          for (let count = 0; count < 31; count++) {
            const absent = await navigate(`${authorize}?${malformed}`)
            expect(absent.status).toBe(404)
            expect(absent.headers.location).toBeUndefined()
          }
        }
        await running.close()
        running = undefined
      }
    } finally {
      await running?.close()
      await owned.drop()
      for (const spy of spies) spy.mockRestore()
    }
  }, 30_000)
})
