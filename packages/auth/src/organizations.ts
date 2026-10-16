import { randomBytes } from 'node:crypto'
import type { Db } from '@hourmere/db'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Ids from cookies, key metadata or requests are checked before they reach a uuid column. */
export const isUuid = (value: string) => UUID.test(value)

export async function isMember(db: Db, userId: string, organizationId: string): Promise<boolean> {
  if (!isUuid(userId) || !isUuid(organizationId)) return false
  const row = await db
    .selectFrom('auth.member')
    .select('id')
    .where('userId', '=', userId)
    .where('organizationId', '=', organizationId)
    .executeTakeFirst()
  return row !== undefined
}

/** The organization's display name: the user's name, else the local part of their email. */
export function personalOrganizationName(user: { name: string; email: string }): string {
  const name = user.name.trim()
  if (name) return name
  return user.email.slice(0, user.email.lastIndexOf('@')) || user.email
}

/** Lowercase ASCII letters, digits and single hyphens, at most 32 characters. */
export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 32)
    .replace(/^-+|-+$/g, '')
  return slug || 'user'
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

function randomSuffix(length = 6): string {
  // `b % 36` is slightly biased, which does not matter for a collision-avoidance suffix.
  return Array.from(randomBytes(length), (b) => ALPHABET[b % ALPHABET.length]).join('')
}

/** The plain slug first, then the slug with random suffixes. */
export function* slugCandidates(base: string, attempts = 10): Generator<string> {
  yield base
  for (let i = 1; i < attempts; i++) yield `${base}-${randomSuffix()}`
}

/**
 * Returns the id of the user's personal organization, creating it when it does not exist:
 * the organization, the user's `owner` membership and the `personal_organizations` marker,
 * in one transaction. Safe to call any number of times and concurrently for the same user.
 */
export async function ensurePersonalOrganization(db: Db, userId: string): Promise<string> {
  const existing = await db
    .selectFrom('personal_organizations')
    .select('organization_id')
    .where('user_id', '=', userId)
    .executeTakeFirst()
  if (existing) return existing.organization_id

  return db.transaction().execute(async (trx) => {
    // Serializes concurrent calls for the same user (two sign-ins at the same moment); the
    // second one finds the organization the first created. NO KEY UPDATE does not block
    // inserts that reference the user, such as new sessions.
    const user = await trx
      .selectFrom('auth.user')
      .select(['name', 'email'])
      .where('id', '=', userId)
      .forNoKeyUpdate()
      .executeTakeFirst()
    if (!user) throw new Error(`cannot create a personal organization: user ${userId} not found`)

    const created = await trx
      .selectFrom('personal_organizations')
      .select('organization_id')
      .where('user_id', '=', userId)
      .executeTakeFirst()
    if (created) return created.organization_id

    const name = personalOrganizationName(user)
    const now = new Date()
    let organizationId: string | undefined
    for (const slug of slugCandidates(slugify(name))) {
      // ON CONFLICT instead of catching the error: a failed statement would abort the
      // whole transaction.
      const row = await trx
        .insertInto('auth.organization')
        .values({ name, slug, createdAt: now })
        .onConflict((oc) => oc.column('slug').doNothing())
        .returning('id')
        .executeTakeFirst()
      if (row) {
        organizationId = row.id
        break
      }
    }
    if (!organizationId) throw new Error('cannot create a personal organization: no free slug')

    await trx
      .insertInto('auth.member')
      .values({ organizationId, userId, role: 'owner', createdAt: now })
      .execute()
    await trx
      .insertInto('personal_organizations')
      .values({ user_id: userId, organization_id: organizationId })
      .execute()
    return organizationId
  })
}
