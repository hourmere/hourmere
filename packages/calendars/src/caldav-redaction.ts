import { inspect } from 'node:util'

const protectedFields = new WeakMap<object, Set<PropertyKey>>()

/** Hide secrets from routine copies/logging; explicit internal field access still works. */
export function redactCalDavField<T extends object>(value: T, field: keyof T): T {
  const existing = protectedFields.get(value)
  if (existing?.has(field)) return value
  const fields = existing ?? new Set<PropertyKey>()
  if (!existing) {
    const redacted = () => ({
      ...value,
      ...Object.fromEntries([...fields].map((key) => [key, '[REDACTED]'])),
    })
    Object.defineProperties(value, {
      toJSON: { value: redacted },
      [inspect.custom]: { value: redacted },
      toString: { value: () => JSON.stringify(redacted()) },
    })
    protectedFields.set(value, fields)
  }
  // A closure, rather than an own data property, also keeps the value out of
  // descriptor inspection. Spread and structuredClone ignore non-enumerable keys.
  const secret = value[field]
  Object.defineProperty(value, field, {
    get: () => secret,
    enumerable: false,
    configurable: false,
  })
  fields.add(field)
  return value
}
