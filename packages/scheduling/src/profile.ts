// The caller's profile: the public handle in their booking URLs (/{handle}/{slug}), their
// time zone and locale. It belongs to the user, not to an organization.
import { DISPLAY_NAME_MAX_LENGTH } from '@hourmere/auth'
import {
  CLAIM_RESERVED_HANDLES,
  isClaimReservedHandle,
  isReservedName,
  RESERVED_NAMES,
} from '@hourmere/core'
import type { Db } from '@hourmere/db'
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

const reserved = () => new DomainError('invalid', 'handle_reserved', 'This handle is reserved')

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
  const userId = ctx.principal.user.id
  // A claim-reserved handle (`route`) is never newly claimed, but whoever already holds it
  // keeps it on every save. Both checks compare with the stored handle inside this one upsert:
  // the row is proposed only if the caller holds the handle in the statement's snapshot, and
  // ON CONFLICT checks again on the locked, latest row, so a rename committed in between is
  // never undone. No row back means the handle was refused. A profile is only deleted with
  // its user (ON DELETE CASCADE), so a save that finds the row gone fails on the user foreign
  // key instead of inserting the handle anew.
  const keptOnly = isClaimReservedHandle(handle)
  const proposed = ctx.db.selectNoFrom((eb) => [
    eb.cast<string>(eb.val(userId), 'uuid').as('user_id'),
    eb.val(handle).as('handle'),
    eb.val(timeZone).as('time_zone'),
    eb.val(locale).as('locale'),
  ])
  try {
    const row = await ctx.db
      .insertInto('profiles')
      .columns(['user_id', 'handle', 'time_zone', 'locale'])
      .expression(
        keptOnly
          ? proposed.where(({ exists, selectFrom }) =>
              exists(
                selectFrom('profiles')
                  .select('user_id')
                  .where('user_id', '=', userId)
                  .where('handle', '=', handle),
              ),
            )
          : proposed,
      )
      .onConflict((oc) => {
        const update = oc.column('user_id').doUpdateSet((eb) => ({
          handle: eb.ref('excluded.handle'),
          time_zone: eb.ref('excluded.time_zone'),
          locale: eb.ref('excluded.locale'),
        }))
        return keptOnly ? update.whereRef('profiles.handle', '=', 'excluded.handle') : update
      })
      // PostgreSQL 18: `old` is NULL for a row the statement inserted.
      .returning([
        'handle',
        'time_zone',
        'locale',
        'created_at',
        'updated_at',
        sql<boolean>`old.user_id IS NULL`.as('created'),
      ])
      .executeTakeFirst()
    if (!row) throw reserved()
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

/** A stored personal handle equal to a claim-reserved name; see findLegacyHandleCollisions. */
export interface LegacyHandleCollision {
  userId: string
  handle: string
}

/**
 * The legacy collision detector: stored personal handles equal to a claim-reserved name
 * (`route`, see isClaimReservedHandle), compared case-insensitively. putProfile and the
 * Cal.com import refuse new claims, so only a handle stored before that can be found. Its
 * pages keep being served and nothing here renames it. Routing forms stay effectively off
 * while one exists, until an operator-led rename with the owner and a server restart; the
 * startup check that computes the effective state calls this (docs/routing-forms.md,
 * Effective state).
 */
export async function findLegacyHandleCollisions(db: Db): Promise<LegacyHandleCollision[]> {
  const rows = await db
    .selectFrom('profiles')
    .select(['user_id', 'handle'])
    .where((eb) => eb(eb.fn('lower', ['handle']), 'in', [...CLAIM_RESERVED_HANDLES]))
    .orderBy('handle')
    .orderBy('user_id')
    .execute()
  return rows.map((row) => ({ userId: row.user_id, handle: row.handle }))
}

function validHandle(value: unknown): string {
  // First, and regardless of case: `Admin` is refused as reserved, not just as uppercase.
  if (typeof value === 'string' && isReservedName(value)) throw reserved()
  // So are `Route` and `ROUTE`. Only the lowercase form can be someone's stored handle, which
  // putProfile lets its holder keep.
  if (typeof value === 'string' && isClaimReservedHandle(value) && !HANDLE_PATTERN.test(value)) {
    throw reserved()
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
