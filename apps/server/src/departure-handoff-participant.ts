import { z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import { DomainError, LOCATION_KINDS } from '@hourmere/scheduling'
import type { ServiceDeps } from './openapi.ts'
import { createRateLimiter, type RateLimiter } from './rate-limit.ts'

const Token = z.string().max(128).openapi({
  description:
    'Private recipient capability from the emailed link fragment. Send only in the JSON body.',
  writeOnly: true,
})
const Version = z.number().int().positive().max(2_147_483_647)
const Decision = z.enum(['accept', 'decline'])

export const ParticipantOfferInput = z.strictObject({ token: Token })
export const ParticipantAnswerInput = ParticipantOfferInput.extend({
  version: Version,
  decision: Decision,
})

const Appointment = z.object({
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  timeZone: z.string(),
  hostName: z.string().nullable(),
  location: z.object({ kind: z.enum(LOCATION_KINDS), address: z.string().optional() }).nullable(),
})

export const ParticipantOfferOutput = z
  .object({
    version: Version,
    expiresAt: z.iso.datetime(),
    role: z.enum(['booker', 'guest']),
    current: Appointment,
    proposed: Appointment,
    answers: z.array(
      z.object({
        label: z.string(),
        value: z.union([z.string(), z.array(z.string()), z.boolean()]),
      }),
    ),
  })
  .openapi('DepartureHandoffParticipantOffer')

export const ParticipantAnswerOutput = z
  .object({ decision: Decision })
  .openapi('DepartureHandoffParticipantAnswer')

export interface ParticipantHandoffDeps extends ServiceDeps {
  handoffs?: { now?: () => Temporal.Instant } | undefined
}

export function requireParticipantHandoffs(deps: ParticipantHandoffDeps) {
  if (!deps.handoffs) throw new DomainError('not_found', 'handoff_offer_unavailable')
}

export function participantHandoffContext(deps: ParticipantHandoffDeps) {
  return {
    db: deps.db,
    now: deps.handoffs?.now ?? deps.now ?? (() => Temporal.Now.instant()),
    automaticMeet: deps.automaticMeet,
    automaticZoom: deps.automaticZoom,
    microsoftCalendarEnabled: deps.microsoftCalendarEnabled,
    scimResourcesEnabled: deps.scimResourcesEnabled,
  }
}

// Both operations and transports use the same trusted-IP budget on this server.
const limits = new WeakMap<Db, RateLimiter>()

export function participantHandoffLimiter(db: Db): RateLimiter {
  let limit = limits.get(db)
  if (!limit) {
    limit = createRateLimiter({ limit: 30, windowSeconds: 60 })
    limits.set(db, limit)
  }
  return limit
}
