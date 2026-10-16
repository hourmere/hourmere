import { apiKey } from '@better-auth/api-key'
import { betterAuth } from 'better-auth'
import { organization } from 'better-auth/plugins/organization'
import pg from 'pg'

/**
 * Better Auth owns the `auth` schema (its own table and column naming). Its pool only
 * sees that schema; application tables live in `public` and reference auth rows by id.
 * After changing plugins, regenerate the SQL with `npm run auth:sql` and add it as a
 * migration in packages/db/migrations.
 */
export function createAuthPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, options: '-c search_path=auth' })
}

export interface AuthConfig {
  pool: pg.Pool
  baseURL: string
  secret: string
}

export function createAuth({ pool, baseURL, secret }: AuthConfig) {
  return betterAuth({
    database: pool,
    baseURL,
    secret,
    advanced: { database: { generateId: 'uuid' } },
    plugins: [organization(), apiKey()],
  })
}

export type Auth = ReturnType<typeof createAuth>
