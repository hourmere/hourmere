import { randomBytes } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { getCookies } from 'better-auth/cookies'
import { makeSignature } from 'better-auth/crypto'
import { sql } from 'kysely'

export const AUTH_SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60

interface BrowserSession {
  secret: string
  publicUrl: string
  expiresIn?: number | undefined
}

/**
 * Creates a Better Auth session in the caller's transaction so a companion proof
 * can commit with it. Return the cookie for use only after that transaction commits.
 */
export async function createBrowserSession(
  trx: Db,
  options: BrowserSession,
  input: {
    userId: string
    organizationId: string
    now: string
    headers: Headers
    ip?: string | undefined
  },
) {
  if (!trx.isTransaction) throw new Error('Browser session creation requires a transaction')
  const expiresIn = options.expiresIn ?? AUTH_SESSION_LIFETIME_SECONDS
  const token = randomBytes(32).toString('base64url')
  const secure = new URL(options.publicUrl).protocol === 'https:'
  const { sessionToken } = getCookies({
    baseURL: options.publicUrl,
    session: { expiresIn },
    advanced: { useSecureCookies: secure },
  })
  const signature = await makeSignature(token, options.secret)
  const cookie = `${sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}; Max-Age=${expiresIn}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
  const session = await trx
    .insertInto('auth.session')
    .values({
      userId: input.userId,
      activeOrganizationId: input.organizationId,
      token,
      createdAt: input.now,
      updatedAt: input.now,
      expiresAt: sql`${input.now}::timestamptz + make_interval(secs => ${expiresIn})`,
      userAgent: input.headers.get('user-agent') ?? '',
      ipAddress: input.ip ?? '',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { id: session.id, cookie }
}
