// Form building blocks: a labelled field with its hint and error, and the summary of errors
// that a failed submit shows and moves focus to (the GOV.UK pattern: each entry links to its
// field).
import { type ReactNode, useEffect, useId, useRef } from 'react'

/** Error messages by field id; a field without an entry is fine. */
export type FieldErrors = Record<string, string>

/** What a field's control needs to be labelled and described. */
export interface ControlProps {
  id: string
  'aria-describedby'?: string
  'aria-invalid'?: true
}

export function describedBy(...ids: (string | false | null | undefined)[]): string | undefined {
  const list = ids.filter(Boolean)
  return list.length ? list.join(' ') : undefined
}

/** The props for the control of field `id`, given its hint and error. */
export function controlProps(id: string, hint: boolean, error: string | undefined): ControlProps {
  const describedById = describedBy(hint && `${id}-hint`, error && `${id}-error`)
  return {
    id,
    ...(describedById && { 'aria-describedby': describedById }),
    ...(error && { 'aria-invalid': true as const }),
  }
}

/** The message under a field (or a group of fields) that failed. */
export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    // Focusable, so the error summary can lead to errors that belong to a group of fields.
    <p id={id} className="field-error" tabIndex={-1}>
      <span className="visually-hidden">Error: </span>
      {children}
    </p>
  )
}

/**
 * A label, an optional hint and error, and the control itself, rendered by `children` with
 * the props that tie it to them.
 */
export function Field({
  id,
  label,
  hint,
  error,
  optional = false,
  className = '',
  children,
}: {
  id: string
  label: ReactNode
  hint?: ReactNode
  error?: string | undefined
  /** Says "(optional)" after the label. */
  optional?: boolean
  className?: string
  children: (props: ControlProps) => ReactNode
}) {
  return (
    <div className={`field${error ? ' field-invalid' : ''} ${className}`.trim()}>
      <label htmlFor={id}>
        {label}
        {optional && <span className="optional"> (optional)</span>}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      )}
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
      {children(controlProps(id, Boolean(hint), error))}
    </div>
  )
}

/**
 * The errors of a failed submit, listed at the top of the form, each linking to its field.
 * It takes focus when it appears (and again for every new failed submit, `attempt`), so
 * keyboard and screen reader users learn what went wrong. `message` is a problem that
 * belongs to no field, e.g. the server could not be reached.
 */
export function ErrorSummary({
  errors,
  labels,
  message,
  attempt,
}: {
  errors: FieldErrors
  /** What to call each field in the list, by id; entries without one show the message alone. */
  labels?: Record<string, string>
  message?: string | null | undefined
  /** Changes with every submit, so the summary takes focus again. */
  attempt: number
}) {
  const box = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const entries = Object.entries(errors)
  const shown = entries.length > 0 || Boolean(message)

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus again on every attempt
  useEffect(() => {
    if (shown) box.current?.focus()
  }, [attempt, shown])

  if (!shown) return null
  return (
    <div
      ref={box}
      className="alert alert-error error-summary"
      role="alert"
      tabIndex={-1}
      aria-labelledby={titleId}
    >
      <h2 id={titleId}>{entries.length > 0 ? 'Please check the form' : 'Could not save'}</h2>
      {message && <p>{message}</p>}
      {entries.length > 0 && (
        <ul>
          {entries.map(([id, error]) => (
            <li key={id}>
              <a
                href={`#${id}`}
                onClick={(e) => {
                  e.preventDefault()
                  // A field, or the message of a group of fields (`<id>-error`).
                  const field =
                    document.getElementById(id) ?? document.getElementById(`${id}-error`)
                  field?.focus()
                  field?.scrollIntoView?.({ block: 'center' })
                }}
              >
                {labels?.[id] ? `${labels[id]}: ` : ''}
                {error}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * A whole number typed into a field: the number, null for an empty field, or NaN for
 * anything else ("1.5", "ten", "1e3").
 */
export function parseWhole(text: string): number | null {
  const value = text.trim()
  if (value === '') return null
  return /^-?\d+$/.test(value) ? Number(value) : Number.NaN
}

/**
 * What is wrong with a whole-number field, or null. `required` false: empty is fine (no
 * limit).
 */
export function wholeNumberProblem(
  text: string,
  { min, max }: { min: number; max: number },
  required: boolean,
): string | null {
  const value = parseWhole(text)
  if (value === null) return required ? 'Enter a number.' : null
  if (!Number.isSafeInteger(value)) return 'Enter a whole number.'
  if (value < min || value > max) {
    return `Enter a number from ${min.toLocaleString('en')} to ${max.toLocaleString('en')}.`
  }
  return null
}
