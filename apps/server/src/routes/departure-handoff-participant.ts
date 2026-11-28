import { createRoute } from '@hono/zod-openapi'
import {
  answerDepartureHandoffParticipantOffer,
  readDepartureHandoffParticipantOffer,
} from '@hourmere/scheduling/departure-handoff-participant'
import { routeBodyLimit } from '../body-limit.ts'
import {
  ParticipantAnswerInput,
  ParticipantAnswerOutput,
  type ParticipantHandoffDeps,
  ParticipantOfferInput,
  ParticipantOfferOutput,
  participantHandoffContext,
  participantHandoffLimiter,
  requireParticipantHandoffs,
} from '../departure-handoff-participant.ts'
import { ErrorBody, json, type RouteModule } from '../openapi.ts'
import { rateLimit } from '../rate-limit.ts'
import { featureGate } from '../rest-scopes.ts'

export function departureHandoffParticipantRoutes(deps: ParticipantHandoffDeps): RouteModule {
  return ({ app, scimResourcesEnabled }) => {
    const context = participantHandoffContext({ ...deps, scimResourcesEnabled })
    const middleware = [
      rateLimit(participantHandoffLimiter(deps.db), { beforeBodyLimit: true }),
      routeBodyLimit(1024),
      featureGate(() => requireParticipantHandoffs(deps)),
    ]
    const security: Record<string, string[]>[] = [{}, { apiKey: [] }]
    const errors = {
      400: { description: 'Invalid request', content: json(ErrorBody) },
      404: {
        description: 'handoff_offer_unavailable: the link can no longer be used',
        content: json(ErrorBody),
      },
      413: { description: 'Request body exceeds 1024 bytes', content: json(ErrorBody) },
      429: {
        description: 'rate_limited; retry after the Retry-After interval',
        content: json(ErrorBody),
      },
    }
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/booking-handoffs/offer',
        operationId: 'readBookingHandoffOffer',
        tags: ['Booking handoffs'],
        summary: 'Read the terms for your private handoff offer',
        description:
          'Requires the recipient capability in the JSON body. Reading records no decision. An optional bearer API key requires read, bookings or full scope and grants no recipient access by itself. Requires DEPARTURE_HANDOFFS_ENABLED=true.',
        security,
        middleware,
        request: { body: { required: true, content: json(ParticipantOfferInput) } },
        responses: {
          200: { description: 'Terms for this recipient', content: json(ParticipantOfferOutput) },
          ...errors,
        },
      }),
      async (c) => {
        const offer = await readDepartureHandoffParticipantOffer(context, c.req.valid('json').token)
        return c.json(ParticipantOfferOutput.parse(offer), 200)
      },
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/booking-handoffs/answer',
        operationId: 'answerBookingHandoffOffer',
        tags: ['Booking handoffs'],
        summary: 'Accept or decline your exact booking handoff offer version',
        description:
          'Requires the recipient capability and reviewed version in the JSON body. The decision does not change the booking. An optional bearer API key requires bookings or full scope and grants no recipient access by itself. Requires DEPARTURE_HANDOFFS_ENABLED=true.',
        security,
        middleware,
        request: { body: { required: true, content: json(ParticipantAnswerInput) } },
        responses: {
          200: { description: 'Recorded decision', content: json(ParticipantAnswerOutput) },
          ...errors,
        },
      }),
      async (c) => {
        const answer = await answerDepartureHandoffParticipantOffer(context, c.req.valid('json'))
        return c.json(ParticipantAnswerOutput.parse(answer), 200)
      },
    )
  }
}
