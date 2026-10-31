import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import type pg from 'pg'

/** Who may create an account (SIGNUP). Existing users can always sign in. */
export const SIGNUP_MODES = ['open', 'first-user', 'closed'] as const
export type SignupMode = (typeof SIGNUP_MODES)[number]

export interface SignupPolicy {
  /**
   * `open`: anyone. `first-user`: the first account, then only `allowedDomains`. `closed`:
   * only `allowedDomains`. A live team invitation also allows its exact address when its
   * inviter is still a member of that team and either has an allowed domain or is the
   * earliest auth user (createdAt, then id).
   */
  mode: SignupMode
  /** Lowercase email domains whose addresses may always sign up; exact match, no subdomains. */
  allowedDomains: readonly string[]
}

/**
 * A lowercase email domain as Better Auth's email check (zod) accepts it, so every allowed
 * domain is one people can actually sign in with.
 */
export const EMAIL_DOMAIN = /^(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,}$/

const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase()

/**
 * Whether a new account may be created for `email` now. Looks at the database only when the
 * answer depends on it: a restricted address needs a live team invitation or the first slot.
 */
export async function maySignUp(db: Db, policy: SignupPolicy, email: string): Promise<boolean> {
  if (policy.mode === 'open' || policy.allowedDomains.includes(domainOf(email))) return true
  const invitation = await db
    .selectFrom('auth.invitation')
    .innerJoin('auth.user as inviter', 'inviter.id', 'auth.invitation.inviterId')
    .select('auth.invitation.id')
    .where(sql<string>`lower(auth.invitation.email)`, '=', email.toLowerCase())
    .where('status', '=', 'pending')
    .where('expiresAt', '>', sql<Date>`clock_timestamp()`)
    .where('organizationId', 'not in', (eb) =>
      eb.selectFrom('personal_organizations').select('organization_id'),
    )
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('auth.member as inviterMembership')
          .select('inviterMembership.id')
          .whereRef('inviterMembership.organizationId', '=', 'auth.invitation.organizationId')
          .whereRef('inviterMembership.userId', '=', 'auth.invitation.inviterId'),
      ),
    )
    .where((eb) =>
      eb.or([
        sql<boolean>`lower(substring(inviter.email FROM '@([^@]*)$')) = ANY (${policy.allowedDomains}::text[])`,
        eb(
          'inviter.id',
          '=',
          eb.selectFrom('auth.user').select('id').orderBy('createdAt').orderBy('id').limit(1),
        ),
      ]),
    )
    .limit(1)
    .executeTakeFirst()
  if (invitation) return true
  if (policy.mode === 'closed') return false
  const anyUser = await db.selectFrom('auth.user').select('id').limit(1).executeTakeFirst()
  return anyUser === undefined
}

/** Whether `email` belongs to an account (Better Auth stores addresses lowercased). */
export async function hasAccount(db: Db, email: string): Promise<boolean> {
  const user = await db
    .selectFrom('auth.user')
    .select('id')
    .where('email', '=', email.toLowerCase())
    .executeTakeFirst()
  return user !== undefined
}

/**
 * Connection settings that hand the policy to the database, which enforces it again in the
 * transaction that inserts the user (migrations 0006, 0012, 0027 and 0046). For Better Auth's pool.
 */
export function signupConnectionOptions({ mode, allowedDomains }: SignupPolicy): string {
  // Also keeps anything but a plain domain out of the connection options.
  if (!SIGNUP_MODES.includes(mode) || !allowedDomains.every((d) => EMAIL_DOMAIN.test(d))) {
    throw new Error('invalid sign-up policy')
  }
  // The domain list is set even when empty, so nothing earlier in the options (e.g. from
  // DATABASE_URL) can add domains.
  return `-c hourmere.signup=${mode} -c hourmere.signup_allowed_domains=${allowedDomains.join(',')}`
}

/**
 * Rejects unless connections from `pool` carry `policy` for the database to enforce. Without
 * the settings the database check allows every insert, so a connection pooler that drops
 * startup parameters would silently turn it off; the server refuses to start instead. It
 * looks at one connection, once.
 *
 * In first-user mode it also refuses repeatable read as the connections' default isolation,
 * under which the database refuses first sign-ups (see migration 0006). Read committed
 * (Postgres's default) and serializable work.
 */
export async function assertSignupEnforced(pool: pg.Pool, policy: SignupPolicy): Promise<void> {
  const { rows } = await pool.query<{
    mode: string | null
    domains: string | null
    isolation: string
  }>(
    `SELECT current_setting('hourmere.signup', true) AS mode,
            current_setting('hourmere.signup_allowed_domains', true) AS domains,
            current_setting('default_transaction_isolation') AS isolation`,
  )
  const mode = rows[0]?.mode || 'nothing'
  const domains = rows[0]?.domains || ''
  if (mode !== policy.mode || domains !== policy.allowedDomains.join(',')) {
    throw new Error(
      `the database connection does not carry the sign-up policy (hourmere.signup is ${mode}, expected ${policy.mode}; allowed domains "${domains}", expected "${policy.allowedDomains.join(',')}"). Connect to Postgres directly, or through a pooler that passes the "options" startup parameter.`,
    )
  }
  if (policy.mode === 'first-user' && rows[0]?.isolation === 'repeatable read') {
    throw new Error(
      'the database connection defaults to repeatable read isolation, under which first-user sign-up cannot be checked; use read committed (the Postgres default) or serializable',
    )
  }
}
