import {
  MAX_MAPPINGS_PER_TARGET,
  ROUTING_FORM_LIMITS,
} from '@hourmere/scheduling/routing-form-config'
import { routingMappingProblem } from '@hourmere/scheduling/routing-form-targets'
import { useEffect, useState } from 'react'
import type { Schemas } from '../../api/client.ts'
import { Field, FieldError, type FieldErrors } from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import {
  type EventRead,
  type RoutingTargetEvents,
  routingEventLabels,
} from './routing-target-events.ts'
import { routingEventMappingErrors } from './routing-target-mappings.ts'

type Target = Schemas['RoutingForm']['fallback']
type Question = Schemas['RoutingForm']['questions'][number]
type EventTarget = Extract<Target, { kind: 'event' }>
type Mapping = EventTarget['mappings'][number]
type Destination = Mapping['destination']
type EventType = Schemas['EventType']

interface TargetProps {
  target: Target
  onChange: (target: Target) => void
  questions: Question[]
  path: string
  errors: FieldErrors
  events: RoutingTargetEvents
}

export function RoutingTargetEditor(props: TargetProps) {
  const { t } = useI18n()
  const { target, onChange, path, errors } = props
  return (
    <div className="stack">
      {errors[path] && <FieldError id={`${path}-error`}>{errors[path]}</FieldError>}
      <Field id={`${path}.kind`} label={t('Destination type')} error={errors[`${path}.kind`]}>
        {(control) => (
          <select
            {...control}
            value={target.kind}
            onChange={(event) =>
              onChange(
                event.target.value === 'event'
                  ? { kind: 'event', eventTypeId: '', mappings: [] }
                  : { kind: 'message', message: '' },
              )
            }
          >
            <option value="message">{t('Show a message')}</option>
            <option value="event">{t('Book an event')}</option>
          </select>
        )}
      </Field>
      {target.kind === 'message' ? (
        <Field
          id={`${path}.message`}
          label={t('Message to show')}
          error={errors[`${path}.message`]}
        >
          {(control) => (
            <textarea
              {...control}
              value={target.message}
              onChange={(event) => onChange({ ...target, message: event.target.value })}
              maxLength={ROUTING_FORM_LIMITS.messageLength}
              rows={3}
              required
            />
          )}
        </Field>
      ) : (
        <EventDestination {...props} target={target} />
      )}
    </div>
  )
}

const statusMessages = {
  list: {
    loading: 'Loading event types…',
    denied: 'You don’t have access to these event types.',
    error: 'Could not load event types.',
    unavailable: 'Could not load event types.',
    context: 'Your team context changed. Reload before making changes.',
  },
  detail: {
    loading: 'Loading booking fields…',
    denied: 'You don’t have access to these booking fields.',
    error: 'Could not load booking fields.',
    unavailable: 'This event type is unavailable.',
    context: 'Your team context changed. Reload before making changes.',
  },
} as const satisfies Record<'list' | 'detail', Record<string, MessageKey>>

function TargetReadStatus({
  kind,
  status,
  retry,
}: {
  kind: keyof typeof statusMessages
  status: Exclude<EventRead<never>['status'], 'ready'>
  retry: () => void
}) {
  const { t } = useI18n()
  const prefix = kind === 'list' ? 'routing-event-types' : 'routing-booking-fields'
  return (
    <div className="stack" data-testid={`${prefix}-${status}`}>
      <p className="muted" role="status">
        {t(statusMessages[kind][status])}
      </p>
      {status === 'error' && (
        <div>
          <button type="button" className="button button-small" onClick={retry}>
            {t('Try again')}
          </button>
        </div>
      )}
    </div>
  )
}

function EventDestination({
  target,
  onChange,
  questions,
  path,
  errors,
  events,
}: Omit<TargetProps, 'target'> & { target: EventTarget }) {
  const { t } = useI18n()
  const { list, bookingFields, retry } = events
  const field = `${path}.eventTypeId`
  if (list.status !== 'ready')
    return (
      <>
        <TargetReadStatus kind="list" status={list.status} retry={retry} />
        {errors[field] && <FieldError id={`${field}-error`}>{errors[field]}</FieldError>}
        <UnavailableMappingErrors path={path} errors={errors} />
      </>
    )

  const labels = routingEventLabels(list.data, t)
  const selected = labels.has(target.eventTypeId)
  const detail = bookingFields(target.eventTypeId)
  const mappings = routingEventMappingErrors(events, questions, [{ path, target }])

  return (
    <>
      <Field
        id={field}
        label={t('Event type')}
        hint={
          target.mappings.length > 0
            ? t('Changing the event type clears its answer mappings.')
            : undefined
        }
        error={errors[field]}
      >
        {(control) => (
          <select
            {...control}
            value={target.eventTypeId}
            onChange={(event) =>
              onChange({ kind: 'event', eventTypeId: event.target.value, mappings: [] })
            }
            required
          >
            <option value="" disabled>
              {t('Choose an event type')}
            </option>
            {target.eventTypeId && !selected && (
              <option value={target.eventTypeId} disabled>
                {t('This event type is unavailable.')}
              </option>
            )}
            {[...labels].map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        )}
      </Field>
      {list.data.length === 0 && (
        <p className="muted" role="status" data-testid="routing-event-types-empty">
          {t('No eligible event types are available to select.')}
        </p>
      )}
      {target.eventTypeId &&
        (detail.status === 'ready' ? (
          <AnswerMappings
            event={detail.data}
            target={target}
            questions={questions}
            path={`${path}.mappings`}
            errors={{ ...mappings, ...errors }}
            onChange={(mappings) => onChange({ ...target, mappings })}
          />
        ) : (
          <>
            <TargetReadStatus kind="detail" status={detail.status} retry={retry} />
            <UnavailableMappingErrors path={path} errors={errors} />
          </>
        ))}
    </>
  )
}

function UnavailableMappingErrors({ path, errors }: { path: string; errors: FieldErrors }) {
  const group = `${path}.mappings`
  return Object.entries(errors)
    .filter(([field]) => field === group || field.startsWith(`${group}.`))
    .map(([field, error]) => (
      <FieldError key={field} id={`${field}-error`}>
        {error}
      </FieldError>
    ))
}

const destinationKey = (destination: Destination) =>
  destination.kind === 'question'
    ? destination.questionId && `question:${destination.questionId}`
    : destination.kind

function AnswerMappings({
  event,
  target,
  questions,
  path,
  errors,
  onChange,
}: {
  event: EventType
  target: EventTarget
  questions: Question[]
  path: string
  errors: FieldErrors
  onChange: (mappings: Mapping[]) => void
}) {
  const { t } = useI18n()
  const [focus, setFocus] = useState<string | null>(null)
  const addId = `${path}-add`
  const { mappings } = target
  useEffect(() => {
    if (!focus) return
    document.getElementById(focus)?.focus()
    setFocus(null)
  }, [focus])

  return (
    <fieldset className="question-card" data-testid="routing-answer-mappings">
      <legend className="question-legend">{t('Answer mappings')}</legend>
      <p className="hint">{t('Use routing answers to prefill these booking fields.')}</p>
      {errors[path] && <FieldError id={`${path}-error`}>{errors[path]}</FieldError>}
      {mappings.map((mapping, index) => (
        <MappingRow
          // biome-ignore lint/suspicious/noArrayIndexKey: Mappings are not reordered and have no ID in the wire format.
          key={index}
          mapping={mapping}
          number={index + 1}
          choices={questions}
          event={event}
          occupied={
            new Set(
              mappings
                .filter((_, i) => i !== index)
                .map(({ destination }) => destinationKey(destination)),
            )
          }
          path={`${path}.${index}`}
          errors={errors}
          onChange={(updated) =>
            onChange(mappings.map((current, i) => (i === index ? updated : current)))
          }
          onRemove={() => {
            onChange(mappings.filter((_, i) => i !== index))
            setFocus(
              mappings.length > 1
                ? `${path}.${Math.min(index, mappings.length - 2)}.questionId`
                : addId,
            )
          }}
        />
      ))}
      <div>
        <button
          id={addId}
          type="button"
          className="button button-small"
          disabled={questions.length === 0 || mappings.length >= MAX_MAPPINGS_PER_TARGET}
          onClick={() => {
            onChange([
              ...mappings,
              { questionId: '', destination: { kind: 'question', questionId: '' } },
            ])
            setFocus(`${path}.${mappings.length}.questionId`)
          }}
        >
          {t('Add an answer mapping')}
        </button>
      </div>
    </fieldset>
  )
}

function MappingRow({
  mapping,
  number,
  choices,
  event,
  occupied,
  path,
  errors,
  onChange,
  onRemove,
}: {
  mapping: Mapping
  number: number
  choices: Question[]
  event: EventType
  occupied: Set<string>
  path: string
  errors: FieldErrors
  onChange: (mapping: Mapping) => void
  onRemove: () => void
}) {
  const { t } = useI18n()
  const source = choices.find((choice) => choice.id === mapping.questionId)
  const bookingFields: { destination: Destination; label: string }[] = [
    { destination: { kind: 'inviteeName' }, label: t('Invitee name') },
    { destination: { kind: 'inviteeEmail' }, label: t('Invitee email') },
    ...event.questions.map(({ id, label }) => ({
      destination: { kind: 'question' as const, questionId: id },
      label,
    })),
  ]
  const allowed = bookingFields.filter(
    ({ destination }) =>
      !!source &&
      !occupied.has(destinationKey(destination)) &&
      routingMappingProblem(source, { questionId: source.id, destination }, event.questions) ===
        undefined,
  )
  const destination = destinationKey(mapping.destination)
  const targetField = event.questions.find(
    (question) =>
      mapping.destination.kind === 'question' && question.id === mapping.destination.questionId,
  )
  const currentOptions = targetField?.type === 'select' ? (targetField.options ?? []) : []
  const routingOptions = source?.type === 'select' ? source.options : []
  const obsoleteOptions = Object.keys(mapping.options ?? {}).some(
    (id) => !routingOptions.some((option) => option.id === id),
  )
  const sourceControl = `${path}.questionId`
  const destinationControl = `${path}.destination`
  const optionPath = `${path}.options`
  return (
    <fieldset className="question-card">
      <legend className="question-legend">{t('Answer mapping {number}', { number })}</legend>
      {errors[path] && <FieldError id={`${path}-error`}>{errors[path]}</FieldError>}
      <div className="question-fields">
        <Field id={sourceControl} label={t('Routing question')} error={errors[sourceControl]}>
          {(control) => (
            <select
              {...control}
              value={mapping.questionId}
              required
              onChange={(event) =>
                onChange({
                  questionId: event.target.value,
                  destination: { kind: 'question', questionId: '' },
                })
              }
            >
              <option value="" disabled>
                {t('Choose a routing question')}
              </option>
              {mapping.questionId && !source && (
                <option value={mapping.questionId} disabled>
                  {t('Previous routing question unavailable')}
                </option>
              )}
              {choices.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label.trim() || t('Question')}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          id={destinationControl}
          label={t('Booking field')}
          error={errors[destinationControl]}
        >
          {(control) => (
            <select
              {...control}
              value={destination}
              required
              disabled={!source}
              onChange={(event) => {
                const next = allowed.find(
                  (item) => destinationKey(item.destination) === event.target.value,
                )
                if (next)
                  onChange({ questionId: mapping.questionId, destination: next.destination })
              }}
            >
              <option value="" disabled>
                {t('Choose a booking field')}
              </option>
              {destination &&
                !allowed.some((item) => destinationKey(item.destination) === destination) && (
                  <option value={destination} disabled>
                    {t('Previous booking field unavailable')}
                  </option>
                )}
              {allowed.map(({ destination, label }) => (
                <option key={destinationKey(destination)} value={destinationKey(destination)}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {errors[optionPath] && (
        <FieldError id={`${optionPath}-error`}>{errors[optionPath]}</FieldError>
      )}
      {source?.type === 'select' && obsoleteOptions && (
        <div>
          <button
            type="button"
            className="button button-small"
            onClick={() => {
              onChange({ ...mapping, options: currentCrosswalk(source.options, mapping.options) })
              document.getElementById(sourceControl)?.focus()
            }}
          >
            {t('Remove obsolete option mappings')}
          </button>
        </div>
      )}
      {source?.type === 'select' && currentOptions.length > 0 && (
        <div className="question-fields">
          {source.options.map(({ id, label }) => {
            const value = mapping.options?.[id] ?? ''
            return (
              <Field
                key={id}
                id={`${optionPath}.${id}`}
                label={
                  <bdi className="user-content">
                    {t('Booking option for “{option}”', { option: label })}
                  </bdi>
                }
              >
                {(control) => (
                  <select
                    {...control}
                    value={value}
                    aria-describedby={errors[optionPath] ? `${optionPath}-error` : undefined}
                    required
                    onChange={(event) => {
                      const values = { ...mapping.options, [id]: event.target.value }
                      onChange({
                        ...mapping,
                        options: currentCrosswalk(source.options, values),
                      })
                    }}
                  >
                    <option value="">{t('Choose a booking option')}</option>
                    {value && !currentOptions.includes(value) && (
                      <option value={value} disabled>
                        {t('Previous booking option unavailable')}
                      </option>
                    )}
                    {currentOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )
          })}
        </div>
      )}
      <div className="question-actions">
        <button
          type="button"
          className="button button-small"
          aria-label={t('Remove mapping {number}', { number })}
          onClick={onRemove}
        >
          {t('Remove mapping')}
        </button>
      </div>
    </fieldset>
  )
}

function currentCrosswalk(
  options: { id: string }[],
  values: Mapping['options'] = {},
): NonNullable<Mapping['options']> {
  return Object.fromEntries(options.flatMap(({ id }) => (values[id] ? [[id, values[id]]] : [])))
}
