import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { format } from 'node:util'
import { startServer } from './server.ts'

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const

/**
 * The OpenAPI document exactly as the server publishes it, made without a database: the
 * server starts as in production (server.ts composes every route module) and is asked for
 * /api/v1/openapi.json, which touches nothing else. `npm run api:types` generates the web
 * app's API types from it.
 *
 * The server's log is held back and only shown if this fails: Better Auth tries the
 * (deliberately unreachable) database once at start and logs that it could not.
 */
export async function openApiDocument(): Promise<unknown> {
  const logged: string[] = []
  const saved = CONSOLE_METHODS.map((method) => [method, console[method]] as const)
  for (const method of CONSOLE_METHODS) {
    console[method] = (...args: unknown[]) => {
      logged.push(format(...args))
    }
  }
  try {
    const server = await startServer({
      // Nothing listens on port 9 (discard) of the loopback address.
      DATABASE_URL: 'postgres://openapi@127.0.0.1:9/openapi',
      AUTO_MIGRATE: 'false',
      PORT: String(await freePort()),
      // Required by the configuration; used for nothing here.
      BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/openapi.json`)
      if (!res.ok) throw new Error(`GET /api/v1/openapi.json answered ${res.status}`)
      return await res.json()
    } finally {
      await server.close()
    }
  } catch (err) {
    throw new Error(`could not get the OpenAPI document; server log:\n${logged.join('\n')}`, {
      cause: err,
    })
  } finally {
    for (const [method, original] of saved) console[method] = original
  }
}
