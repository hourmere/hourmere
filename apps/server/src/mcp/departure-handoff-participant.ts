import {
  answerDepartureHandoffParticipantOffer,
  readDepartureHandoffParticipantOffer,
} from '@hourmere/scheduling/departure-handoff-participant'
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
import { rateLimitKey } from '../rate-limit.ts'
import { defineTool, RateLimited, type Tool, type ToolCall } from './tools.ts'

export function departureHandoffParticipantTools(deps: ParticipantHandoffDeps): Tool[] {
  const context = participantHandoffContext(deps)
  const limit = participantHandoffLimiter(deps.db)
  const privateOffer = {
    privateInput: () => true,
    privateDiagnostics: true,
    privateValidationMessage: 'Invalid handoff offer request',
    requireEnabled: () => requireParticipantHandoffs(deps),
    checkRateLimit(call: ToolCall) {
      const retryAfter = limit.hit(rateLimitKey(call.trustedIp))
      if (retryAfter !== undefined) throw new RateLimited(retryAfter, 'ip')
    },
  }
  return [
    defineTool({
      name: 'read_booking_handoff_offer',
      title: 'Read your booking handoff offer',
      description:
        'Read only your own terms using the private token from the offer email. Reading records no decision. API keys need read, bookings or full scope.',
      input: ParticipantOfferInput,
      output: ParticipantOfferOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      ...privateOffer,
      run(args) {
        return readDepartureHandoffParticipantOffer(context, args.token)
      },
    }),
    defineTool({
      name: 'answer_booking_handoff_offer',
      title: 'Accept or decline your booking handoff offer',
      description:
        'Record your decision only after you have reviewed the exact version with your private token. A successful answer consumes the token. A decline closes that version. A decision does not change a booking. API keys need bookings or full scope.',
      input: ParticipantAnswerInput,
      output: ParticipantAnswerOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      ...privateOffer,
      run(args) {
        return answerDepartureHandoffParticipantOffer(context, args)
      },
    }),
  ]
}
