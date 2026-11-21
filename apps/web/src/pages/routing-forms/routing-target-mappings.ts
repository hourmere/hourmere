import { routingMappingProblem } from '@hourmere/scheduling/routing-form-targets'
import type { Schemas } from '../../api/client.ts'
import type { FieldErrors } from '../../components/forms.tsx'
import type { RoutingTargetEvents } from './routing-target-events.ts'

type Target = Schemas['RoutingForm']['fallback']
type Question = Schemas['RoutingForm']['questions'][number]

/** Current booking fields add compatibility checks to the shared draft shape validator. */
export function routingEventMappingErrors(
  events: RoutingTargetEvents,
  questions: Question[],
  targets: { path: string; target: Target }[],
): FieldErrors {
  const errors: FieldErrors = {}
  for (const { path, target } of targets) {
    if (target.kind !== 'event') continue
    const detail = events.bookingFields(target.eventTypeId)
    // Loading or inaccessible booking fields do not establish a validation failure.
    if (detail.status !== 'ready') continue
    for (const [index, mapping] of target.mappings.entries()) {
      const source = questions.find((question) => question.id === mapping.questionId)
      if (!source) continue
      const field = `${path}.mappings.${index}`
      const problem = routingMappingProblem(source, mapping, detail.data.questions)
      if (problem === 'unknown_destination' && mapping.destination.kind === 'question') {
        if (mapping.destination.questionId)
          errors[`${field}.destination`] = 'Choose a current booking field.'
      } else if (problem === 'incompatible_mapping') {
        errors[`${field}.destination`] = 'Choose a booking field that accepts this answer type.'
      } else if (problem === 'incompatible_options') {
        errors[`${field}.options`] = 'Choose a current booking option for each routing option.'
      }
    }
  }
  return errors
}
