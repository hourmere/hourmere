import { serve } from '@hono/node-server'
import { createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, createPool, runMigrations } from '@hourmere/db'
import { createLogMailer, createSmtpMailer, type Mailer } from '@hourmere/mail'
import { sql } from 'kysely'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'

const config = loadConfig()
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
  console.warn(
    'WARNING: email is not configured (SMTP_URL is not set); sign-in links are printed to this log instead of being sent',
  )
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
  webDist: config.WEB_DIST,
})

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  const providers = Object.keys(config.socialProviders)
  console.log(
    `Hourmere listening on :${info.port} (${config.PUBLIC_URL}); sign-in: email${providers.map((p) => `, ${p}`).join('')}`,
  )
})

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`)
  server.close(async () => {
    await Promise.all([db.destroy(), authPool.end()])
    process.exit(0)
  })
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
