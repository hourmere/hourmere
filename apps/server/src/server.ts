import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import {
  assertSignupEnforced,
  createAuth,
  createAuthPool,
  createCallerResolver,
} from '@hourmere/auth'
import { createDb, createPool, runMigrations } from '@hourmere/db'
import { createJobs } from '@hourmere/jobs'
import { createLogMailer, createSmtpMailer, type Mailer } from '@hourmere/mail'
import { bookingNotificationJob } from '@hourmere/notifications'
import { sql } from 'kysely'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { installOneLineConsole } from './one-line-console.ts'
import { bookingRoutes } from './routes/bookings.ts'
import { eventTypeRoutes } from './routes/event-types.ts'
import { profileRoutes } from './routes/profile.ts'
import { publicRoutes } from './routes/public.ts'
import { scheduleRoutes } from './routes/schedules.ts'
import { createWorkerHealthApp } from './worker-health.ts'

export interface RunningServer {
  port: number
  /**
   * Stops accepting requests, stops the job workers (waiting for running jobs up to a
   * timeout), closes the database pools and restores the console.
   */
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
  // Sign-in emails go out after the request is answered, and shutdown does not wait for them;
  // the count is for saying how many it drops.
  let sending = 0
  const sender = mailer
  const countingMailer: Mailer = {
    async send(message) {
      sending += 1
      try {
        await sender.send(message)
      } finally {
        sending -= 1
      }
    },
  }

  const role = config.HOURMERE_ROLE
  // A worker serves only /api/health, for the container health check: no sign-in, no API.
  const authPool =
    role === 'worker' ? undefined : createAuthPool(config.DATABASE_URL, config.signup)
  if (authPool) {
    try {
      await assertSignupEnforced(authPool, config.signup)
    } catch (err) {
      await Promise.all([db.destroy(), authPool.end()])
      throw err
    }
  }

  // Background jobs: every role queues them, `all` and `worker` run them.
  const jobs = createJobs({
    connectionString: config.DATABASE_URL,
    definitions: [bookingNotificationJob({ db, mailer, publicUrl: config.PUBLIC_URL })],
    work: role !== 'web',
    // pg-boss installs and upgrades its own `pgboss` schema; with AUTO_MIGRATE=false,
    // `npm run db:migrate` does that too.
    migrate: config.AUTO_MIGRATE,
    instanceName: role,
  })
  try {
    await jobs.start()
  } catch (err) {
    await Promise.all([db.destroy(), authPool?.end()])
    throw err
  }
  const checkDb = async () => {
    await sql`SELECT 1`.execute(db)
  }

  let fetch: Parameters<typeof serve>[0]['fetch']
  if (!authPool) {
    fetch = createWorkerHealthApp({ checkDb, checkJobs: () => jobs.check() }).fetch
  } else {
    const auth = createAuth({
      pool: authPool,
      db,
      baseURL: config.PUBLIC_URL,
      secret: config.BETTER_AUTH_SECRET,
      mailer: countingMailer,
      signup: config.signup,
      socialProviders: config.socialProviders,
    })
    fetch = createApp({
      checkDb,
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl: config.PUBLIC_URL,
      trustedProxies: config.trustedProxies,
      webDist: config.WEB_DIST,
      // Route groups hold only db (closed below) and in-memory rate limiters.
      routes: [
        profileRoutes({ db }),
        scheduleRoutes({ db }),
        eventTypeRoutes({ db }),
        publicRoutes({ db }),
        bookingRoutes({ db }),
      ],
    }).fetch
  }

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch, port: config.PORT }, (info: AddressInfo) => {
      if (role === 'worker') {
        console.log(`Hourmere worker running jobs; health check on :${info.port}/api/health`)
      } else {
        const providers = Object.keys(config.socialProviders)
        const { mode, allowedDomains } = config.signup
        const signup = `${mode}${allowedDomains.length ? `, plus ${allowedDomains.join(', ')}` : ''}`
        console.log(
          `Hourmere listening on :${info.port} (${config.PUBLIC_URL}); sign-in: email${providers.map((p) => `, ${p}`).join('')}; sign-up: ${signup}; jobs: ${role === 'all' ? 'run here' : 'queued for a worker'}`,
        )
      }
      resolve(s)
    })
  })

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Requests first (one still running may queue a job), then jobs (waiting for running
        // ones up to a timeout), then the pools the jobs use.
        server.close(async (err) => {
          try {
            if (sending)
              console.warn(`shutting down: dropping ${sending} email(s) still being sent`)
            await jobs.stop().finally(() => Promise.all([db.destroy(), authPool?.end()]))
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
