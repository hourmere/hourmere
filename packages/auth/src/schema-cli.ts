// Entry point for the Better Auth CLI (`npm run auth:sql`); not used at runtime.
// Run it against a database migrated to the latest version: the output then contains only
// what changed (e.g. after enabling a plugin) and goes into a new file in packages/db/migrations.
import { existsSync } from 'node:fs'
import { createDb, createPool } from '@hourmere/db'
import { createLogMailer } from '@hourmere/mail'
import { createAuth, createAuthPool } from './index.ts'

const envFile = new URL('../../../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile)
const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set')

const placeholder = { clientId: 'schema-generation-only', clientSecret: 'schema-generation-only' }
// Does not affect the schema.
const signup = { mode: 'closed', allowedDomains: [] } as const

export const auth = createAuth({
  pool: createAuthPool(url, signup),
  db: createDb(createPool(url)),
  baseURL: 'http://localhost:3000',
  secret: 'schema-generation-only-not-a-real-secret',
  mailer: createLogMailer(),
  signup,
  mcpOAuth: true,
  // Every optional feature on, so the generated schema covers all of them.
  socialProviders: { google: placeholder, microsoft: placeholder },
})
