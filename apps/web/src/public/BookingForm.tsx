import { type FormEvent, useId, useRef, useState } from 'react'
import { ErrorSummary } from '../components/forms.tsx'
import { useI18n } from '../i18n/runtime.tsx'
import { literal, msg, type UiText } from '../i18n/translate.ts'
import {
  type Answer,
  answerError,
  emailError,
  type FieldErrors,
  guestsFor,
  isEmptyGuest,
  LIMITS,
  nameError,
  type Question,
} from './validation.ts'

export interface BookingFormValues {
  name: string
  email: string
  guests: { name: string; email: string }[]
  answers: Record<string, Answer | undefined>
}

interface BookingFormProps {
  allowGuests: boolean
  questions: readonly Question[]
  values: BookingFormValues
  onChange: (values: BookingFormValues) => void
  /** Errors from the server, by field id (see validation.ts). */
  serverErrors: FieldErrors
  formError: UiText | null
  submitting: boolean
  onSubmit: () => void
}

/** Client-side checks, by field id; empty when the form may be sent. */
export function validateBookingForm(
  questions: readonly Question[],
  values: BookingFormValues,
): FieldErrors {
  const errors: FieldErrors = {}
  const name = nameError(values.name)
  if (name) errors.name = name
  const email = emailError(values.email)
  if (email) errors.email = email
  values.guests.forEach((guest, i) => {
    if (isEmptyGuest(guest)) return
    const guestName = nameError(guest.name, 'a name')
    if (guestName) errors[`guest-${i}-name`] = guestName
    const guestEmail = emailError(guest.email)
    if (guestEmail) errors[`guest-${i}-email`] = guestEmail
  })
  if (guestsFor(values.guests).length > LIMITS.guests)
    errors.guests = msg('Add at most {0} guests.', { '0': LIMITS.guests })
  for (const q of questions) {
    const error = answerError(q, values.answers[q.id])
    if (error) errors[`q-${q.id}`] = error
  }
  return errors
}

/**
 * The invitee's details: name, email, the event type's questions (all six kinds) and up to ten
 * guests. Problems show next to their fields and in a focused summary linking to each one.
 */
export function BookingForm({
  allowGuests,
  questions,
  values,
  onChange,
  serverErrors,
  formError,
  submitting,
  onSubmit,
}: BookingFormProps) {
  const { t, ui } = useI18n()

  const prefix = useId()
  const form = useRef<HTMLFormElement>(null)
  const [clientErrors, setClientErrors] = useState<FieldErrors>({})
  const [submitted, setSubmitted] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const errors = { ...serverErrors, ...clientErrors }
  const fieldId = (field: string) => `${prefix}${field}`

  function update(change: Partial<BookingFormValues>) {
    const next = { ...values, ...change }
    onChange(next)
    // Once people have tried to submit, errors follow their corrections.
    if (submitted) setClientErrors(validateBookingForm(questions, next))
  }

  function setAnswer(id: string, answer: Answer | undefined) {
    update({ answers: { ...values.answers, [id]: answer } })
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitted(true)
    setAttempt((current) => current + 1)
    const found = validateBookingForm(questions, values)
    setClientErrors(found)
    if (Object.keys(found).length > 0) return
    onSubmit()
  }

  const labels: Record<string, UiText> = {
    name: 'Your name',
    email: 'Email',
    ...Object.fromEntries(questions.map((q) => [`q-${q.id}`, literal(q.label)])),
    guests: 'Guests',
    ...Object.fromEntries(
      values.guests.flatMap((_, i) => [
        [`guest-${i}-name`, msg('Guest {0} name', { '0': i + 1 })],
        [`guest-${i}-email`, msg('Guest {0} email', { '0': i + 1 })],
      ]),
    ),
  }
  // Follow the rendered fields even when server errors arrive in a different order.
  const summaryErrors: FieldErrors = {}
  for (const id of new Set([...Object.keys(labels), ...Object.keys(errors)])) {
    const error = errors[id]
    if (!error) continue
    const label = labels[id]
    summaryErrors[fieldId(id)] = label ? msg('{0}: {1}', { '0': ui(label), '1': ui(error) }) : error
  }

  const describedBy = (field: string, hint?: string) =>
    [errors[field] ? `${fieldId(field)}-error` : null, hint].filter(Boolean).join(' ') || undefined

  const errorText = (field: string) =>
    errors[field] ? (
      <p className="field-error" id={`${fieldId(field)}-error`}>
        {ui(errors[field])}
      </p>
    ) : null

  const textInput = (
    field: string,
    label: string,
    value: string,
    set: (v: string) => void,
    options: { type?: string; autoComplete?: string; required?: boolean } = {},
  ) => (
    <div className="field">
      <label htmlFor={fieldId(field)}>
        {ui(label)}
        {options.required === false && <span className="optional">{t(' (optional)')}</span>}
      </label>
      <input
        id={fieldId(field)}
        data-field={field}
        type={options.type ?? 'text'}
        autoComplete={options.autoComplete}
        value={value}
        aria-invalid={errors[field] ? true : undefined}
        aria-describedby={describedBy(field)}
        aria-required={options.required !== false}
        onChange={(e) => set(e.target.value)}
      />
      {errorText(field)}
    </div>
  )

  return (
    <form ref={form} className="stack booking-form" noValidate onSubmit={submit}>
      <ErrorSummary errors={summaryErrors} message={formError} attempt={attempt} />
      {textInput('name', 'Your name', values.name, (name) => update({ name }), {
        autoComplete: 'name',
      })}
      {textInput('email', 'Email', values.email, (email) => update({ email }), {
        type: 'email',
        autoComplete: 'email',
      })}

      {questions.map((q) => (
        <QuestionField
          key={q.id}
          question={q}
          id={fieldId(`q-${q.id}`)}
          field={`q-${q.id}`}
          value={values.answers[q.id]}
          onChange={(answer) => setAnswer(q.id, answer)}
          error={errors[`q-${q.id}`]}
        />
      ))}

      {(allowGuests || values.guests.length > 0) && (
        <fieldset
          className="guests"
          id={fieldId('guests')}
          data-field="guests"
          tabIndex={-1}
          aria-describedby={describedBy('guests')}
        >
          <legend>
            {t('Guests')}
            <span className="optional">
              {t(' (optional, up to {count})', { count: LIMITS.guests })}
            </span>
          </legend>
          {errorText('guests')}
          {values.guests.map((guest, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: guests are edited in place by position
            <div className="guest" key={i}>
              {textInput(
                `guest-${i}-name`,
                t('Guest {0} name', { '0': i + 1 }),
                guest.name,
                (name) =>
                  update({ guests: values.guests.map((g, j) => (j === i ? { ...g, name } : g)) }),
                { autoComplete: 'off' },
              )}
              {textInput(
                `guest-${i}-email`,
                t('Guest {0} email', { '0': i + 1 }),
                guest.email,
                (email) =>
                  update({ guests: values.guests.map((g, j) => (j === i ? { ...g, email } : g)) }),
                { type: 'email', autoComplete: 'off' },
              )}
              <button
                type="button"
                className="button button-small guest-remove"
                onClick={() => update({ guests: values.guests.filter((_, j) => j !== i) })}
              >
                {t('Remove guest')} {i + 1}
              </button>
            </div>
          ))}
          {allowGuests && values.guests.length < LIMITS.guests ? (
            <button
              type="button"
              className="button button-small"
              onClick={() => {
                update({ guests: [...values.guests, { name: '', email: '' }] })
                // Focus the new guest's name once it is there.
                requestAnimationFrame(() =>
                  form.current
                    ?.querySelector<HTMLElement>(
                      `[data-field="guest-${values.guests.length}-name"]`,
                    )
                    ?.focus(),
                )
              }}
            >
              {t('Add a guest')}
            </button>
          ) : (
            <p className="hint">
              {t('You can add up to')} {LIMITS.guests} {t('guests.')}
            </p>
          )}
        </fieldset>
      )}

      <button type="submit" className="button button-primary button-block" disabled={submitting}>
        {submitting ? t('Booking…') : t('Confirm booking')}
      </button>
    </form>
  )
}

interface QuestionFieldProps {
  question: Question
  id: string
  field: UiText
  value: Answer | undefined
  onChange: (value: Answer | undefined) => void
  error: UiText | undefined
}

function QuestionField({ question: q, id, field, value, onChange, error }: QuestionFieldProps) {
  const { t, ui } = useI18n()

  const errorId = `${id}-error`
  const common = {
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? errorId : undefined,
  } as const
  const errorText = error ? (
    <p className="field-error" id={errorId}>
      {ui(error)}
    </p>
  ) : null
  const label = (
    <>
      {q.label}
      {!q.required && <span className="optional">{t(' (optional)')}</span>}
    </>
  )

  switch (q.type) {
    case 'short_text':
    case 'phone':
      return (
        <div className="field">
          <label htmlFor={id}>{label}</label>
          <input
            id={id}
            data-field={field}
            type={q.type === 'phone' ? 'tel' : 'text'}
            autoComplete={q.type === 'phone' ? 'tel' : 'off'}
            value={typeof value === 'string' ? value : ''}
            aria-required={q.required}
            onChange={(e) => onChange(e.target.value)}
            {...common}
          />
          {errorText}
        </div>
      )
    case 'long_text':
      return (
        <div className="field">
          <label htmlFor={id}>{label}</label>
          <textarea
            id={id}
            data-field={field}
            rows={4}
            value={typeof value === 'string' ? value : ''}
            aria-required={q.required}
            onChange={(e) => onChange(e.target.value)}
            {...common}
          />
          {errorText}
        </div>
      )
    case 'select':
      return (
        <div className="field">
          <label htmlFor={id}>{label}</label>
          <select
            id={id}
            data-field={field}
            value={typeof value === 'string' ? value : ''}
            aria-required={q.required}
            onChange={(e) => onChange(e.target.value)}
            {...common}
          >
            <option value="">{q.required ? t('Choose…') : t('No answer')}</option>
            {(q.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          {errorText}
        </div>
      )
    case 'multi_select': {
      const chosen = Array.isArray(value) ? value : []
      return (
        <fieldset className="field choices" id={id} data-field={field} tabIndex={-1} {...common}>
          <legend>{label}</legend>
          {(q.options ?? []).map((option, i) => (
            <label key={option} className="choice" htmlFor={`${id}-${i}`}>
              <input
                id={`${id}-${i}`}
                type="checkbox"
                checked={chosen.includes(option)}
                onChange={(e) =>
                  onChange(
                    e.target.checked ? [...chosen, option] : chosen.filter((c) => c !== option),
                  )
                }
              />
              <span>{option}</span>
            </label>
          ))}
          {errorText}
        </fieldset>
      )
    }
    case 'checkbox':
      return (
        <div className="field">
          <label className="choice" htmlFor={id}>
            <input
              id={id}
              data-field={field}
              type="checkbox"
              checked={value === true}
              aria-required={q.required}
              onChange={(e) => onChange(e.target.checked)}
              {...common}
            />
            <span>{label}</span>
          </label>
          {errorText}
        </div>
      )
  }
}
