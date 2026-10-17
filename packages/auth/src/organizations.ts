import { randomBytes } from 'node:crypto'
import { isReservedName } from '@hourmere/core'
import type { Db } from '@hourmere/db'
import { APIError } from 'better-auth/api'
import type { OrganizationOptions } from 'better-auth/plugins/organization'

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

/** Appended to a slug that would be a reserved name (see @hourmere/core's RESERVED_NAMES). */
export const RESERVED_SLUG_SUFFIX = '-user'

/**
 * Lowercase ASCII letters, digits and single hyphens, at most 32 characters. Never a reserved
 * name: an organization's slug may become a public path (/{slug}), like a profile handle, so
 * `Admin` becomes `admin-user` rather than `admin`.
 */
export function slugify(value: string): string {
  const slug =
    value
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 32)
      .replace(/^-+|-+$/g, '') || 'user'
  return isReservedName(slug) ? `${slug}${RESERVED_SLUG_SUFFIX}` : slug
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

function randomSuffix(length = 6): string {
  // `b % 36` is slightly biased, which does not matter for a collision-avoidance suffix.
  return Array.from(randomBytes(length), (b) => ALPHABET[b % ALPHABET.length]).join('')
}

/** The plain slug first, then the slug with random suffixes; never a reserved name. */
export function* slugCandidates(base: string, attempts = 10): Generator<string> {
  for (let i = 0; i < attempts; i++) {
    const candidate = i === 0 ? base : `${base}-${randomSuffix()}`
    if (!isReservedName(candidate)) yield candidate
  }
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

/** The user a personal organization belongs to; undefined for a team organization. */
export async function personalOwner(db: Db, organizationId: string): Promise<string | undefined> {
  if (!isUuid(organizationId)) return undefined
  const row = await db
    .selectFrom('personal_organizations')
    .select('user_id')
    .where('organization_id', '=', organizationId)
    .executeTakeFirst()
  return row?.user_id
}

const refuse = (message: string) =>
  new APIError('FORBIDDEN', { code: 'PERSONAL_ORGANIZATION', message })

/**
 * Better Auth organization hooks that protect the public URL namespace and keep each personal
 * organization under its user's control. Without them a user could invite someone as owner
 * who then removes them, leaving the user's
 * session and API keys without an organization. Team work belongs in a team organization.
 * (Leaving is not hooked: Better Auth refuses to let the only owner leave.)
 */
export function organizationGuards(db: Db): NonNullable<OrganizationOptions['organizationHooks']> {
  const checkSlug = (slug: string | undefined) => {
    if (slug !== undefined && isReservedName(slug))
      throw new APIError('BAD_REQUEST', {
        code: 'ORGANIZATION_SLUG_RESERVED',
        message: 'This organization slug is reserved. Choose another one.',
      })
  }
  const isPersonal = async (organizationId: string) =>
    (await personalOwner(db, organizationId)) !== undefined
  const noOneElse = async ({ organization }: { organization: { id: string } }) => {
    if (await isPersonal(organization.id)) {
      throw refuse('A personal organization has no other members; create a team organization')
    }
  }
  return {
    beforeCreateOrganization: async ({ organization }) => checkSlug(organization.slug),
    // A display-name-only edit must still work for an existing legacy reserved slug.
    beforeUpdateOrganization: async ({ organization }) => checkSlug(organization.slug),
    // It lives as long as its user: deleting the user deletes it.
    beforeDeleteOrganization: async ({ organization }) => {
      if (await isPersonal(organization.id)) {
        throw refuse('A personal organization cannot be deleted')
      }
    },
    beforeCreateInvitation: noOneElse,
    beforeAcceptInvitation: noOneElse,
    beforeAddMember: noOneElse,
    beforeRemoveMember: async ({ member, organization }) => {
      if ((await personalOwner(db, organization.id)) === member.userId) {
        throw refuse('The owner cannot be removed from their personal organization')
      }
    },
    beforeUpdateMemberRole: async ({ member, organization }) => {
      if ((await personalOwner(db, organization.id)) === member.userId) {
        throw refuse('The owner of a personal organization keeps the owner role')
      }
    },
  }
}
