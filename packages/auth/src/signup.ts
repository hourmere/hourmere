import type { Db } from '@hourmere/db'

/** Who may create an account (SIGNUP). Existing users can always sign in. */
export const SIGNUP_MODES = ['open', 'first-user', 'closed'] as const
export type SignupMode = (typeof SIGNUP_MODES)[number]

export interface SignupPolicy {
  /**
   * `open`: anyone. `first-user`: the first account, then only `allowedDomains`. `closed`:
   * only `allowedDomains`.
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
 * answer depends on it: in first-user mode, for an address outside the allowed domains.
 */
export async function maySignUp(db: Db, policy: SignupPolicy, email: string): Promise<boolean> {
  if (policy.mode === 'open' || policy.allowedDomains.includes(domainOf(email))) return true
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
 * transaction that inserts the user (migration 0006). For Better Auth's pool.
 */
export function signupConnectionOptions({ mode, allowedDomains }: SignupPolicy): string {
  // Also keeps anything but a plain domain out of the connection options.
  if (!SIGNUP_MODES.includes(mode) || !allowedDomains.every((d) => EMAIL_DOMAIN.test(d))) {
    throw new Error('invalid sign-up policy')
  }
  const options = [`-c hourmere.signup=${mode}`]
  if (allowedDomains.length) {
    options.push(`-c hourmere.signup_allowed_domains=${allowedDomains.join(',')}`)
  }
  return options.join(' ')
}
