import { timingSafeEqual } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { writeSsoAuditEvent } from '@hourmere/db/audit'
import { defineJob } from '@hourmere/jobs'
import { resolveSsoDomainTxt, SSO_TRANSPORT_LIMITS } from '@hourmere/outbound/sso'
import { sql } from 'kysely'
import { z } from 'zod'
import type { SsoCapabilities } from './sso.ts'
import { SSO_DOMAIN_LIMITS, ssoDomainChallengeDigest } from './sso-domains.ts'
import { databaseClock } from './sso-mailbox-proof.ts'

export const SSO_DOMAIN_RECHECK_JOB = 'sso-domain-recheck'
export const SSO_DOMAIN_RECHECK_BATCH = 20
export interface DomainRecheckDeps {
  db: Db
  publicUrl: string
  capabilities: SsoCapabilities
  now?: ((db: Db) => Promise<string>) | undefined
  resolveTxt?: ((name: string) => Promise<string[][]>) | undefined
}
const enabled = (deps: DomainRecheckDeps) =>
  deps.capabilities.ssoOidcEnabled || deps.capabilities.ssoSamlEnabled

/** Injected trusted resolvers obey the production resolver's absolute time budget too. */
async function lookup(deps: DomainRecheckDeps, name: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (deps.resolveTxt ?? resolveSsoDomainTxt)(name),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('DNS deadline')),
          SSO_TRANSPORT_LIMITS.ssoConnectTimeout,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Expiry suspends authority; only explicit operator maintenance can retire a claim. */
export async function recheckSsoDomains(deps: DomainRecheckDeps, signal?: AbortSignal) {
  if (!enabled(deps) || signal?.aborted) return 0
  const clock = deps.now ?? databaseClock
  const scanTime = await clock(deps.db)
  const candidates = await deps.db
    .selectFrom('sso_domains')
    .select(['id', 'name'])
    .where('retired_at', 'is', null)
    .where('verified_at', 'is not', null)
    .where('next_check_at', 'is not', null)
    .where((eb) =>
      eb.or([
        eb('next_check_at', '<=', new Date(scanTime)),
        eb('verification_expires_at', '<=', new Date(scanTime)),
      ]),
    )
    .orderBy('next_check_at')
    .orderBy('id')
    .limit(SSO_DOMAIN_RECHECK_BATCH)
    .execute()
  let checked = 0
  for (const candidate of candidates) {
    if (signal?.aborted) break
    checked += await deps.db.transaction().execute(async (trx) => {
      // Match foreground verification/rotation/retirement lock order without waiting on it.
      const lock = await sql<{
        locked: boolean
      }>`SELECT pg_try_advisory_xact_lock(hashtextextended(${`sso-domain:${candidate.name}`}, 0)) AS locked`.execute(
        trx,
      )
      if (!lock.rows[0]?.locked) return 0
      const row = await trx
        .selectFrom('sso_domains')
        .selectAll()
        .where('id', '=', candidate.id)
        .executeTakeFirstOrThrow()
      let now = await clock(trx)
      const expires = row.verification_expires_at
        ? new Date(row.verification_expires_at).getTime()
        : 0
      if (
        row.retired_at ||
        !row.verified_at ||
        !row.next_check_at ||
        (new Date(row.next_check_at).getTime() > Date.parse(now) && expires > Date.parse(now))
      )
        return 0
      const auditBase = {
        organizationId: row.organization_id,
        actor: { type: 'system' as const, id: SSO_DOMAIN_RECHECK_JOB },
        credential: { type: 'none' as const },
        targetType: 'sso_domain',
        targetId: row.id,
      }
      const suspend = async () => {
        // Clearing the schedule is the durable replay marker for this expired generation.
        await trx
          .updateTable('sso_domains')
          .set({ next_check_at: null })
          .where('id', '=', row.id)
          .execute()
        await writeSsoAuditEvent(trx, { ...auditBase, action: 'sso_domain.expired', details: {} })
      }
      if (expires <= Date.parse(now)) {
        await suspend()
        return 1
      }
      let outcome: 'positive' | 'failed' | 'unknown'
      try {
        const answers = await lookup(deps, `_hourmere-sso.${row.name}`)
        outcome = answers.some((parts) =>
          timingSafeEqual(
            Buffer.from(ssoDomainChallengeDigest(deps, row, parts.join('')), 'hex'),
            Buffer.from(row.challenge_digest, 'hex'),
          ),
        )
          ? 'positive'
          : 'failed'
      } catch {
        outcome = 'unknown'
      }
      now = await clock(trx)
      if (expires <= Date.parse(now)) {
        await suspend()
        return 1
      }
      if (signal?.aborted) return 0
      const renewedExpiry = Date.parse(now) + SSO_DOMAIN_LIMITS.domainVerificationLifetime * 1000
      await trx
        .updateTable('sso_domains')
        .set({
          last_checked_at: now,
          last_check_outcome: outcome,
          next_check_at: new Date(
            Math.min(
              Date.parse(now) + SSO_DOMAIN_LIMITS.domainRecheckInterval * 1000,
              outcome === 'positive' ? renewedExpiry : expires,
            ),
          ).toISOString(),
          ...(outcome === 'positive'
            ? { verification_expires_at: new Date(renewedExpiry).toISOString() }
            : {}),
        })
        .where('id', '=', row.id)
        .execute()
      await writeSsoAuditEvent(trx, {
        ...auditBase,
        action: 'sso_domain.renewed',
        details: { outcome: outcome === 'positive' ? 'passed' : outcome },
      })
      return 1
    })
  }
  return checked
}

export function ssoDomainRecheckJob(deps: DomainRecheckDeps) {
  return defineJob({
    name: SSO_DOMAIN_RECHECK_JOB,
    payload: z.strictObject({}),
    ...(enabled(deps) ? { schedule: { cron: '*/5 * * * *', payload: {} } } : {}),
    handler: async (_, { signal }) => {
      await recheckSsoDomains(deps, signal)
    },
  })
}
