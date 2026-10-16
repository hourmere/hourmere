import { serve } from '@hono/node-server'
import { createDb, createPool, runMigrations } from '@hourmere/db'
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

const app = createApp({
  checkDb: async () => {
    await sql`SELECT 1`.execute(db)
  },
  webDist: config.WEB_DIST,
})

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`Hourmere listening on :${info.port} (${config.PUBLIC_URL})`)
})

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`)
  server.close(async () => {
    await db.destroy()
    process.exit(0)
  })
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
