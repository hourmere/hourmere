import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, createPool, runMigrations } from '@hourmere/db'
import { createLogMailer, createSmtpMailer, type Mailer } from '@hourmere/mail'
import { sql } from 'kysely'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { bookingTools } from './mcp/bookings.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { whoamiTool } from './mcp/whoami.ts'
import { installOneLineConsole } from './one-line-console.ts'
import { bookingRoutes } from './routes/bookings.ts'
import { publicRoutes } from './routes/public.ts'

export interface RunningServer {
  port: number
  /** Stops accepting requests, closes the database pools and restores the console. */
  close(): Promise<void>
}

/** Starts Hourmere from environment variables (see .env.example). */
export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<RunningServer> {
  // First, before anything can log: one line per console call, control characters escaped.
  const restoreConsole = installOneLineConsole()
  try {
    return await start(env, restoreConsole)
  } catch (err) {
    restoreConsole()
    throw err
  }
}

async function start(env: NodeJS.ProcessEnv, restoreConsole: () => void): Promise<RunningServer> {
  const config = loadConfig(env)
  const pool = createPool(config.DATABASE_URL)
  const db = createDb(pool)

  if (config.AUTO_MIGRATE) {
    const applied = await runMigrations(pool)
    if (applied.length) console.log(`migrations applied: ${applied.join(', ')}`)
  }

  let mailer: Mailer
  if (config.SMTP_URL && config.MAIL_FROM) {
    mailer = createSmtpMailer({ url: config.SMTP_URL, from: config.MAIL_FROM })
  } else {
    const bar = '!'.repeat(78)
    for (const line of [
      bar,
      '!! EMAIL IS NOT CONFIGURED: SMTP_URL is not set.',
      '!! Sign-in links are printed to this log instead of being emailed, so anyone who can',
      '!! read this log can sign in as any user. Fine for trying Hourmere on your own; set',
      '!! SMTP_URL and MAIL_FROM before anyone else uses this instance. Hosted and',
      '!! internet-facing deployments must always set them.',
      bar,
    ]) {
      console.warn(line)
    }
    mailer = createLogMailer()
  }

  const authPool = createAuthPool(config.DATABASE_URL)
  const auth = createAuth({
    pool: authPool,
    db,
    baseURL: config.PUBLIC_URL,
    secret: config.BETTER_AUTH_SECRET,
    mailer,
    socialProviders: config.socialProviders,
  })

  const app = createApp({
    checkDb: async () => {
      await sql`SELECT 1`.execute(db)
    },
    authHandler: auth.handler,
    resolveCaller: createCallerResolver({ auth, db }),
    publicUrl: config.PUBLIC_URL,
    trustedProxies: config.trustedProxies,
    webDist: config.WEB_DIST,
    // Route groups hold only db (closed below) and in-memory rate limiters.
    routes: [publicRoutes({ db }), bookingRoutes({ db })],
    mcp: mcpEndpoint({ tools: [whoamiTool, ...bookingTools({ db })] }),
  })

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: config.PORT }, (info: AddressInfo) => {
      const providers = Object.keys(config.socialProviders)
      console.log(
        `Hourmere listening on :${info.port} (${config.PUBLIC_URL}); sign-in: email${providers.map((p) => `, ${p}`).join('')}`,
      )
      resolve(s)
    })
  })

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(async (err) => {
          try {
            await Promise.all([db.destroy(), authPool.end()])
            restoreConsole()
            if (err) reject(err)
            else resolve()
          } catch (closeErr) {
            reject(closeErr)
          }
        })
      }),
  }
}
