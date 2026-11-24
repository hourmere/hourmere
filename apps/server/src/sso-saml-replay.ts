import { createHash } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { type RawBuilder, sql } from 'kysely'
import { maximumSamlAssertionLifetime, samlClockSkew } from './sso-saml-limits.ts'
import type { VerifiedSamlResponse } from './sso-saml-verifier.ts'

const skew = { seconds: samlClockSkew }
const cleanupBatch = 1_000
const dateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
const compare = Temporal.Instant.compare

export class SamlTimingError extends Error {
  readonly reason: 'timing_invalid' | 'request_mismatch' | 'request_expired' | 'replay'

  constructor(reason: SamlTimingError['reason']) {
    super('SAML response rejected')
    this.name = 'SamlTimingError'
    this.reason = reason
  }
}

function parseTime(value: string | null) {
  if (value === null || !dateTime.test(value)) throw new SamlTimingError('timing_invalid')
  try {
    return Temporal.Instant.from(value)
  } catch {
    throw new SamlTimingError('timing_invalid')
  }
}

/** Checks the signed assertion's bounds and returns the deadline before skew is applied. */
export function validateSamlTiming(
  assertion: VerifiedSamlResponse['assertion'],
  now: Temporal.Instant,
) {
  const issueInstant = parseTime(assertion.issueInstant)
  const conditionsStart = parseTime(assertion.conditions.notBefore)
  const conditionsEnd = parseTime(assertion.conditions.notOnOrAfter)
  const bearerEnd = parseTime(assertion.subjectConfirmation.notOnOrAfter)
  const bearerStart =
    assertion.subjectConfirmation.notBefore === null
      ? null
      : parseTime(assertion.subjectConfirmation.notBefore)

  const latestStart = now.add(skew)
  if (
    compare(issueInstant, latestStart) > 0 ||
    compare(conditionsStart, latestStart) > 0 ||
    compare(conditionsStart, conditionsEnd) >= 0 ||
    (bearerStart !== null &&
      (compare(bearerStart, latestStart) > 0 || compare(bearerStart, bearerEnd) >= 0))
  ) {
    throw new SamlTimingError('timing_invalid')
  }

  const ageLimit = issueInstant.add({ seconds: maximumSamlAssertionLifetime })
  const deadline = [bearerEnd, conditionsEnd].reduce(
    (earliest, bound) => (compare(bound, earliest) < 0 ? bound : earliest),
    ageLimit,
  )
  if (compare(now, deadline.add(skew)) >= 0) throw new SamlTimingError('timing_invalid')
  return deadline
}

type OutstandingSamlRequest = {
  id: string
  organizationId: string
  providerId: string
  expiresAt: Temporal.Instant
}

/** Retain PostgreSQL's microseconds independently of session DateStyle and TimeZone. */
export function samlDatabaseInstantText(instant: RawBuilder<unknown>) {
  return sql<string>`to_char(${instant} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
}

export async function samlDatabaseNow(db: Db) {
  const { now } = await db
    .selectNoFrom(samlDatabaseInstantText(sql`clock_timestamp()`).as('now'))
    .executeTakeFirstOrThrow()
  return Temporal.Instant.from(now)
}

export function samlRequestExpired(expiresAt: Temporal.Instant, now: Temporal.Instant) {
  return compare(now, expiresAt) >= 0
}

const digest = (id: string) => createHash('sha256').update(id).digest('hex')

/**
 * The caller supplies the persisted outstanding request and the provider used to verify
 * the response. The request ID and the signed assertion and response IDs are consumed together.
 */
export async function consumeSamlReplay(
  db: Db,
  { assertion, response }: VerifiedSamlResponse,
  { id, organizationId, providerId, expiresAt }: OutstandingSamlRequest,
  verifiedProviderId: string,
) {
  if (
    providerId !== verifiedProviderId ||
    id !== assertion.subjectConfirmation.inResponseTo ||
    id !== response.inResponseTo
  ) {
    throw new SamlTimingError('request_mismatch')
  }

  function check(now: Temporal.Instant) {
    if (samlRequestExpired(expiresAt, now)) throw new SamlTimingError('request_expired')
    return validateSamlTiming(assertion, now)
  }

  try {
    return await db.transaction().execute(async (trx) => {
      const deadline = check(await samlDatabaseNow(trx))
      const skewedExpiry = deadline.add(skew)
      const retainUntil = compare(skewedExpiry, expiresAt) >= 0 ? skewedExpiry : expiresAt
      // Round up to PostgreSQL's precision to preserve the retention lower bound.
      const retained = {
        organization_id: organizationId,
        provider_id: providerId,
        retain_until: retainUntil
          .round({ smallestUnit: 'microsecond', roundingMode: 'ceil' })
          .toString(),
      }
      // Insert in a consistent order and let the primary key serialize competitors.
      await trx
        .insertInto('sso_replay_cache')
        .values([
          { ...retained, kind: 'saml_request', key_digest: digest(id) },
          { ...retained, kind: 'saml_assertion', key_digest: digest(assertion.id) },
          ...(response.signed
            ? [{ ...retained, kind: 'saml_response', key_digest: digest(response.id) }]
            : []),
        ])
        .execute()
      // Uniqueness or foreign-key checks can wait even if the insert ultimately succeeds.
      return check(await samlDatabaseNow(trx))
    })
  } catch (error) {
    if (error instanceof Error && 'code' in error && 'constraint' in error) {
      if (error.code === '23505' && error.constraint === 'sso_replay_cache_pkey') {
        throw new SamlTimingError('replay')
      }
      if (error.code === '23514' && error.constraint === 'sso_replay_cache_starts_retained') {
        throw new SamlTimingError('timing_invalid')
      }
    }
    throw error
  }
}

/** Removes one bounded batch and skips rows locked by another cleanup. */
export async function purgeExpiredSamlReplay(db: Db, limit = cleanupBatch) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > cleanupBatch) {
    throw new RangeError(`SAML replay cleanup limit must be between 1 and ${cleanupBatch}`)
  }
  const { numAffectedRows } = await sql`
    WITH expired AS (
      SELECT provider_id, kind, key_digest FROM sso_replay_cache
      WHERE retain_until <= statement_timestamp()
      ORDER BY retain_until
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM sso_replay_cache r USING expired e
    WHERE (r.provider_id, r.kind, r.key_digest) = (e.provider_id, e.kind, e.key_digest)
  `.execute(db)
  return Number(numAffectedRows ?? 0n)
}
