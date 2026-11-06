import { inspect } from 'node:util'

/** Redact routine object logging while retaining explicit internal field access. */
export function redactCalDavField<T extends object>(value: T, field: keyof T): T {
  const redacted = () => ({ ...value, [field]: '[REDACTED]' })
  return Object.defineProperties(value, {
    toJSON: { value: redacted },
    [inspect.custom]: { value: redacted },
    toString: { value: () => JSON.stringify(redacted()) },
  })
}
