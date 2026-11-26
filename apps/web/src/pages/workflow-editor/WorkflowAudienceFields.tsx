import { type ReactNode, useId, useLayoutEffect, useRef } from 'react'
import type { Schemas } from '../../api/client.ts'
import { Field } from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { BOOKING } from '../../limits.ts'

type Condition = Schemas['WorkflowCondition']
type ConditionType = Condition['field']
type Scope = Schemas['WorkflowScope']
type OwnerKind = Schemas['WorkflowOwner']['kind']
type EventType = Pick<Schemas['EventType'], 'id' | 'title' | 'questions'>
type Question = Schemas['Question']
type Recipient = Extract<Schemas['WorkflowAction'], { type: 'email' }>['recipients'][number]
type Source = Extract<Condition, { field: 'booking_source' }>['value']
type Location = Extract<Condition, { field: 'location_kind' }>['value']
type Comparison = Extract<Condition, { field: 'guest_count' }>['operator']

// The workflow definition limits conditions to five AND predicates.
const MAX_CONDITIONS = 5
const conditionLabels = {
  event_type: 'Event type',
  booking_source: 'Booking source',
  answer: 'Booking answer',
  location_kind: 'Meeting location',
  guest_count: 'Guest count',
} as const satisfies Record<ConditionType, string>
const teamConditionTypes: readonly ConditionType[] = ['event_type', 'guest_count']
const sourceLabels = {
  web: 'Booking page',
  embed: 'Embedded booking page',
  api: 'REST API',
  mcp: 'MCP',
} as const satisfies Record<Source, string>
const locationLabels = {
  google_meet: 'Automatic Google Meet',
  zoom: 'Automatic Zoom',
  microsoft_teams: 'Microsoft Teams',
  phone: 'Phone call',
  in_person: 'In person',
  link: 'Custom link',
} as const satisfies Record<Location, string>
const comparisonLabels = {
  equals: 'Equals',
  at_least: 'At least',
  at_most: 'At most',
} as const satisfies Record<Comparison, string>
export const workflowRecipientLabels = {
  booker: 'Booker',
  guests: 'Guests',
  hosts: 'Hosts',
} as const satisfies Record<Recipient, string>

export function isTeamWorkflowCondition(condition: Condition) {
  return teamConditionTypes.includes(condition.field)
}

function eligibleQuestions(scope: Scope, ownerKind: OwnerKind, eventTypes: readonly EventType[]) {
  if (ownerKind !== 'personal' || scope.type !== 'event_type') return []
  const event = eventTypes.find(({ id }) => id === scope.eventTypeId)
  return event?.questions.filter(({ type }) => type === 'select' || type === 'checkbox') ?? []
}

function newCondition(field: ConditionType): Condition {
  switch (field) {
    case 'event_type':
      return { field, operator: 'equals', value: '' }
    case 'booking_source':
      return { field, operator: 'equals', value: 'web' }
    case 'answer':
      return { field, operator: 'equals', questionId: '', value: '' }
    case 'location_kind':
      return { field, operator: 'equals', value: 'google_meet' }
    case 'guest_count':
      return { field, operator: 'equals', value: 0 }
  }
}

export function WorkflowConditionsFields({
  conditions,
  onChange,
  ownerKind,
  scope,
  eventTypes,
}: {
  conditions: Condition[]
  onChange: (conditions: Condition[]) => void
  ownerKind: OwnerKind
  scope: Scope
  eventTypes: readonly EventType[]
}) {
  const { t } = useI18n()
  const id = useId()
  const nextFocus = useRef<string | undefined>(undefined)
  const questions = eligibleQuestions(scope, ownerKind, eventTypes)
  const choices = (Object.keys(conditionLabels) as ConditionType[]).filter((field) => {
    if (ownerKind === 'team' && !teamConditionTypes.includes(field)) return false
    if (field === 'answer') return questions.length > 0
    if (field === 'event_type') return eventTypes.length > 0
    return true
  })

  useLayoutEffect(() => {
    if (nextFocus.current) document.getElementById(nextFocus.current)?.focus()
    nextFocus.current = undefined
  })

  function add() {
    nextFocus.current = `${id}-${conditions.length}-type`
    onChange([...conditions, newCondition(eventTypes.length ? 'event_type' : 'guest_count')])
  }

  function remove(index: number) {
    const rest = conditions.filter((_, position) => index !== position)
    nextFocus.current = rest.length ? `${id}-${Math.min(index, rest.length - 1)}-type` : `${id}-add`
    onChange(rest)
  }

  return (
    <fieldset className="form-fieldset stack">
      <legend>{t('Conditions')}</legend>
      {conditions.length > 0 && <p className="hint">{t('All conditions must match.')}</p>}
      {conditions.map((condition, index) => {
        const rowId = `${id}-${index}`
        const update = (next: Condition) =>
          onChange(conditions.map((current, position) => (position === index ? next : current)))
        if (ownerKind === 'team' && !isTeamWorkflowCondition(condition)) return null
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are controlled, only add/remove, and focus follows removal
          <fieldset key={index} className="form-fieldset stack">
            <legend>{t('Condition {number}', { number: index + 1 })}</legend>
            <Field id={`${rowId}-type`} label={t('Condition type')}>
              {(props) => (
                <select
                  {...props}
                  value={condition.field}
                  onChange={(event) => update(newCondition(event.target.value as ConditionType))}
                >
                  {choices.includes(condition.field) || (
                    <option value={condition.field}>{t(conditionLabels[condition.field])}</option>
                  )}
                  {choices.map((field) => (
                    <option key={field} value={field}>
                      {t(conditionLabels[field])}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <ConditionValue
              id={rowId}
              condition={condition}
              onChange={update}
              eventTypes={eventTypes}
              questions={questions}
            />
            <div>
              <button type="button" className="button button-small" onClick={() => remove(index)}>
                {t('Remove condition {number}', { number: index + 1 })}
              </button>
            </div>
          </fieldset>
        )
      })}
      <div>
        <button
          id={`${id}-add`}
          className="button"
          type="button"
          onClick={add}
          disabled={conditions.length >= MAX_CONDITIONS}
        >
          {t('Add condition')}
        </button>
      </div>
    </fieldset>
  )
}

function ConditionValue({
  id,
  condition,
  onChange,
  eventTypes,
  questions,
}: {
  id: string
  condition: Condition
  onChange: (condition: Condition) => void
  eventTypes: readonly EventType[]
  questions: readonly Question[]
}) {
  const { t } = useI18n()
  const fieldId = `${id}-value`
  switch (condition.field) {
    case 'event_type':
      return (
        <Field id={fieldId} label={t('Event type')}>
          {(props) => (
            <select
              {...props}
              required
              value={eventTypes.some(({ id }) => id === condition.value) ? condition.value : ''}
              onChange={(event) => onChange({ ...condition, value: event.target.value })}
            >
              <option value="">{t('Choose…')}</option>
              {eventTypes.map(({ id, title }) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </select>
          )}
        </Field>
      )
    case 'booking_source':
      return (
        <ConditionSelect
          id={fieldId}
          label={t(conditionLabels[condition.field])}
          value={condition.value}
          options={sourceLabels}
          onChange={(value) => onChange({ ...condition, value })}
        />
      )
    case 'location_kind':
      return (
        <ConditionSelect
          id={fieldId}
          label={t(conditionLabels[condition.field])}
          value={condition.value}
          options={locationLabels}
          onChange={(value) => onChange({ ...condition, value })}
        />
      )
    case 'answer':
      return <AnswerValue id={id} condition={condition} onChange={onChange} questions={questions} />
    case 'guest_count':
      return (
        <div className="field-grid">
          <ConditionSelect
            id={`${id}-operator`}
            label={t('Comparison')}
            value={condition.operator}
            options={comparisonLabels}
            onChange={(operator) => onChange({ ...condition, operator })}
          />
          <Field id={fieldId} label={t('Guest count')}>
            {(props) => (
              <input
                {...props}
                required
                type="number"
                min={0}
                max={BOOKING.maxGuests}
                value={Number.isNaN(condition.value) ? '' : condition.value}
                onChange={(event) => onChange({ ...condition, value: event.target.valueAsNumber })}
              />
            )}
          </Field>
        </div>
      )
  }
}

function ConditionSelect<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string
  label: ReactNode
  value: T
  options: Record<T, MessageKey>
  onChange: (value: T) => void
}) {
  const { t } = useI18n()
  return (
    <Field id={id} label={label}>
      {(props) => (
        <select {...props} value={value} onChange={(event) => onChange(event.target.value as T)}>
          {(Object.keys(options) as T[]).map((option) => (
            <option key={option} value={option}>
              {t(options[option])}
            </option>
          ))}
        </select>
      )}
    </Field>
  )
}

function AnswerValue({
  id,
  condition,
  onChange,
  questions,
}: {
  id: string
  condition: Extract<Condition, { field: 'answer' }>
  onChange: (condition: Condition) => void
  questions: readonly Question[]
}) {
  const { t } = useI18n()
  const question = questions.find(({ id }) => id === condition.questionId)
  const checked = question?.type === 'checkbox'
  const answer = checked
    ? typeof condition.value === 'boolean'
      ? String(condition.value)
      : ''
    : typeof condition.value === 'string' && question?.options?.includes(condition.value)
      ? condition.value
      : ''
  return (
    <div className="field-grid">
      <Field
        id={`${id}-question`}
        label={t('Question')}
        hint={
          questions.length === 0 &&
          t('Choose an event type with an eligible question or remove this condition.')
        }
      >
        {(props) => (
          <select
            {...props}
            required
            value={question?.id ?? ''}
            onChange={(event) =>
              onChange({ ...condition, questionId: event.target.value, value: '' })
            }
          >
            <option value="">{t('Choose…')}</option>
            {questions.map(({ id, label }) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        )}
      </Field>
      {question && (
        <Field id={`${id}-value`} label={t('Answer')}>
          {(props) => (
            <select
              {...props}
              required
              value={answer}
              onChange={({ target: { value } }) =>
                onChange({
                  ...condition,
                  value: checked && value !== '' ? value === 'true' : value,
                })
              }
            >
              <option value="">{t('Choose…')}</option>
              {checked ? (
                <>
                  <option value="true">{t('Checked')}</option>
                  <option value="false">{t('Unchecked')}</option>
                </>
              ) : (
                question.options?.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))
              )}
            </select>
          )}
        </Field>
      )}
    </div>
  )
}

export function WorkflowRecipientsField({
  recipients,
  onChange,
}: {
  recipients: Recipient[]
  onChange: (recipients: Recipient[]) => void
}) {
  const { t } = useI18n()
  const first = useRef<HTMLInputElement>(null)
  const required = t('Choose at least one recipient.')
  useLayoutEffect(() => {
    first.current?.setCustomValidity(recipients.length > 0 ? '' : required)
  }, [recipients.length, required])
  return (
    <fieldset className="form-fieldset">
      <legend>{t('Recipients')}</legend>
      {(Object.keys(workflowRecipientLabels) as Recipient[]).map((recipient, index) => (
        <label key={recipient} className="checkbox">
          <input
            ref={index === 0 ? first : undefined}
            type="checkbox"
            checked={recipients.includes(recipient)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...recipients, recipient]
                  : recipients.filter((current) => current !== recipient),
              )
            }
          />
          <span>{t(workflowRecipientLabels[recipient])}</span>
        </label>
      ))}
    </fieldset>
  )
}
