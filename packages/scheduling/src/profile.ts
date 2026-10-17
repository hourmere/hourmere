// The caller's profile: the public handle in their booking URLs (/{handle}/{slug}), their
// time zone and locale. It belongs to the user, not to an organization.
import { DISPLAY_NAME_MAX_LENGTH } from '@hourmere/auth'
import { isReservedName, RESERVED_NAMES } from '@hourmere/core'
import { sql } from 'kysely'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { isConstraintViolation, SQLSTATE, timestamp, validTimeZone } from './internal.ts'
import { cleanText } from './text.ts'

export interface Profile {
  handle: string
  /** IANA time zone name. */
  timeZone: string
  /** BCP 47 language tag, e.g. `en` or `pt-BR`. */
  locale: string
  createdAt: string
  updatedAt: string
}

export interface ProfileInput {
  handle: string
  timeZone: string
  locale: string
}

/** Lowercase letters, digits and inner hyphens, 1–40 characters (the `profiles` CHECK). */
export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
export const HANDLE_MAX_LENGTH = 40
export const LOCALE_MAX_LENGTH = 35

/**
 * Handles nobody can claim, because /{handle} would shadow or pass for a page of the app, the
 * API or the product (@hourmere/core's RESERVED_NAMES, checked case-insensitively). A stored
 * handle that became reserved later is not served: its booking pages answer 404 (see
 * findPublicEventType), and saving the profile again needs a new handle.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = RESERVED_NAMES

const notFound = () =>
  new DomainError('not_found', 'profile_not_found', 'Create a profile with PUT /api/v1/profile')

/** The caller's profile; `profile_not_found` until they have created one. */
export async function getProfile(ctx: ServiceContext): Promise<Profile> {
  const row = await ctx.db
    .selectFrom('profiles')
    .select(['handle', 'time_zone', 'locale', 'created_at', 'updated_at'])
    .where('user_id', '=', ctx.principal.user.id)
    .executeTakeFirst()
  if (!row) throw notFound()
  return toProfile(row)
}

/**
 * Creates the caller's profile or replaces it. `created` tells which happened. The time
 * zone and locale are stored normalized (`europe/berlin` → `Europe/Berlin`, `pt-br` →
 * `pt-BR`).
 */
export async function putProfile(
  ctx: ServiceContext,
  input: ProfileInput,
): Promise<{ profile: Profile; created: boolean }> {
  const handle = validHandle(input.handle)
  const timeZone = validTimeZone(input.timeZone)
  const locale = validLocale(input.locale)
  try {
    const row = await ctx.db
      .insertInto('profiles')
      .values({ user_id: ctx.principal.user.id, handle, time_zone: timeZone, locale })
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet((eb) => ({
          handle: eb.ref('excluded.handle'),
          time_zone: eb.ref('excluded.time_zone'),
          locale: eb.ref('excluded.locale'),
        })),
      )
      // PostgreSQL 18: `old` is NULL for a row the statement inserted.
      .returning([
        'handle',
        'time_zone',
        'locale',
        'created_at',
        'updated_at',
        sql<boolean>`old.user_id IS NULL`.as('created'),
      ])
      .executeTakeFirstOrThrow()
    return { profile: toProfile(row), created: row.created }
  } catch (error) {
    if (isConstraintViolation(error, SQLSTATE.uniqueViolation, 'profiles_handle_key')) {
      throw new DomainError('conflict', 'handle_taken', 'This handle is already taken', {
        cause: error,
      })
    }
    throw error
  }
}

/** Account display name, independently of profile onboarding and acting organization. */
export async function updateDisplayName(
  ctx: ServiceContext,
  value: unknown,
): Promise<{ name: string }> {
  const name = cleanText(value, { max: DISPLAY_NAME_MAX_LENGTH })
  if (name === undefined) {
    throw new DomainError(
      'invalid',
      'invalid_display_name',
      `Name must be a single line of text between 1 and ${DISPLAY_NAME_MAX_LENGTH} characters.`,
    )
  }
  const row = await ctx.db
    .updateTable('auth.user')
    .set({ name, updatedAt: new Date(ctx.now().epochMilliseconds) })
    .where('id', '=', ctx.principal.user.id)
    .returning('name')
    .executeTakeFirst()
  if (!row) throw new DomainError('not_found', 'user_not_found')
  return row
}

function validHandle(value: unknown): string {
  // First, and regardless of case: `Admin` is refused as reserved, not just as uppercase.
  if (typeof value === 'string' && isReservedName(value)) {
    throw new DomainError('invalid', 'handle_reserved', 'This handle is reserved')
  }
  if (typeof value !== 'string' || !HANDLE_PATTERN.test(value)) {
    throw new DomainError(
      'invalid',
      'invalid_handle',
      'handle must be 1–40 lowercase letters, digits or hyphens, and start and end with a letter or digit',
    )
  }
  return value
}

function validLocale(value: unknown): string {
  let canonical: string | undefined
  if (typeof value === 'string' && value.length <= LOCALE_MAX_LENGTH) {
    try {
      canonical = Intl.getCanonicalLocales(value)[0]
    } catch {
      // RangeError: not a well-formed language tag.
    }
  }
  if (!canonical) {
    throw new DomainError(
      'invalid',
      'invalid_locale',
      'locale must be a BCP 47 language tag such as en or pt-BR',
    )
  }
  return canonical
}

function toProfile(row: {
  handle: string
  time_zone: string
  locale: string
  created_at: Date
  updated_at: Date
}): Profile {
  return {
    handle: row.handle,
    timeZone: row.time_zone,
    locale: row.locale,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  }
}
