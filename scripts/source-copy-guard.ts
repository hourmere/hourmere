// Test support for source-copy mutation controls. A control evaluates a mutated copy of a
// production function and requires a verifier assertion to fail. When the copy itself is broken
// (a missing binding, a binding of the wrong kind, code that does not run), many verifiers turn
// the copy's engine error into an AssertionError (`.resolves`, `.rejects.toMatchObject`, a
// nested `expect(...).toThrow()`), so the broken copy would look like a kill. `guardCopy` records
// those engine errors where they leave the copy, and `expectKilled` turns them into a harness
// failure instead of a kill. It cannot see an engine error the copy swallows or rethrows without
// `cause`, or a wrong binding that raises none; an unmutated-copy test still covers those. A host
// that catches the copy's errors itself (an HTTP framework answering 500) reports them with
// `recordCopyFault`.
//
// It lives beside the other repository-wide test support (test-clock, test-database-setup) and
// depends on no workspace package, so every workspace's tests can import it.
import { expect } from 'vitest'

/**
 * Engine errors a broken copy raises: an unbound name, code that does not parse, or a binding
 * of the wrong kind. A mutation can raise one too (Temporal throws a TypeError for an undefined
 * duration); its control then fails as a harness error rather than passing, and needs a
 * mutation that fails an assertion instead.
 */
const BROKEN_COPY_ERRORS = [ReferenceError, SyntaxError, TypeError]
const copyFaults = new WeakMap<object, unknown[]>()
/** Each mutated copy from `mutatedPair`, mapped to its unmutated twin. */
const twins = new WeakMap<object, object>()
const guardedFunctions = new WeakSet<object>()

/** The first engine error in `error` or its `cause` chain, if any. */
export function brokenCopyError(error: unknown): unknown {
  for (let current = error, depth = 0; current instanceof Error && depth < 8; depth += 1) {
    if (BROKEN_COPY_ERRORS.some((type) => current instanceof type)) return current
    current = current.cause
  }
  return undefined
}

/**
 * The only TypeErrors an `unmutated` rerun may excuse: a property read or write on undefined or
 * null, which is what removing a guard causes. Any other TypeError (`x is not a function`) points
 * at a binding of the wrong kind and always fails.
 */
const removedGuardCrash = (error: unknown) =>
  error instanceof TypeError &&
  /^Cannot (?:(?:read|set) properties of (?:undefined|null)|destructure)\b/.test(error.message)

/** A control whose copy raised an engine error: a harness failure, never a kill. */
export class BrokenSourceCopyError extends Error {
  override readonly name = 'BrokenSourceCopyError'

  /** `confirmed`: the unmutated copy raised it too, so the copy itself is broken. */
  constructor(fault: unknown, confirmed = false) {
    super(
      confirmed
        ? `The unmutated source copy raised ${String(fault)} as well, so the copy itself is ` +
            'broken (a missing or wrong binding, or code that does not run); this is not a kill.'
        : `The source copy raised ${String(fault)}, so this is not a kill. Either the copy is ` +
            'broken (a missing or wrong binding, or code that does not run) or the mutation ' +
            'crashes the code instead of failing an assertion. Build the copy with `mutatedPair` ' +
            'and pass its twin as `unmutated` to tell the two apart.',
      { cause: fault },
    )
  }
}

type Callable = (...args: unknown[]) => unknown

const isClass = (value: Callable) => /^class\b/.test(Function.prototype.toString.call(value))

/** A plain object (a factory's result, a module namespace) with at least one function member. */
const hasMethods = (value: unknown): value is object => {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(Object.getOwnPropertyDescriptors(value)).some(
    (descriptor) => typeof descriptor.value === 'function',
  )
}

export interface GuardOptions {
  /** A guarded copy this one belongs to, such as a second copy a scenario builds: they share faults. */
  partOf?: object
}

/**
 * Wraps the copy's functions so that every engine error escaping one of them is recorded, then
 * rethrown unchanged. Accepts an object of exports (for example a module namespace) or a single
 * function, whose own properties count as further exports. Classes and non-function exports pass
 * through untouched, so `instanceof`, `new` and constants keep working. Synchronous throws and
 * rejected thenables are both recorded. What a guarded function returns or resolves to is part
 * of the copy too: a returned function, and the function members of a returned plain object (a
 * factory's result), are guarded the same way, and `this` is forwarded.
 */
export function guardCopy<T extends object>(copy: T, { partOf }: GuardOptions = {}): T {
  const faults = partOf === undefined ? [] : copyFaults.get(partOf)
  if (!faults) throw new Error('guardCopy needs `partOf` to be a copy wrapped by guardCopy')
  const record = (error: unknown): never => {
    const fault = brokenCopyError(error)
    if (fault) faults.push(fault)
    throw error
  }
  const wrapped = new WeakMap<object, object>()
  const guardValue = (value: unknown): unknown => {
    const callable =
      typeof value === 'function' && !isClass(value as Callable) && !guardedFunctions.has(value)
    if (!callable && !hasMethods(value)) return value
    const known = wrapped.get(value as object)
    if (known) return known
    if (callable) {
      const run = value as Callable
      const guarded = function guarded(this: unknown, ...args: unknown[]) {
        let result: unknown
        try {
          result = Reflect.apply(run, this, args)
        } catch (error) {
          return record(error)
        }
        return typeof (result as PromiseLike<unknown> | undefined)?.then === 'function'
          ? Promise.resolve(result).then(guardValue, record)
          : guardValue(result)
      }
      guardedFunctions.add(guarded)
      wrapped.set(run, guarded)
      for (const [name, member] of Object.entries(run))
        Object.assign(guarded, {
          [name]: typeof member === 'function' ? guardValue(member) : member,
        })
      return guarded
    }
    const object = value as object
    const guarded = Object.create(Object.getPrototypeOf(object)) as object
    wrapped.set(object, guarded)
    const descriptors = Object.getOwnPropertyDescriptors(object)
    for (const descriptor of Object.values(descriptors))
      if (typeof descriptor.value === 'function') descriptor.value = guardValue(descriptor.value)
    Object.defineProperties(guarded, descriptors)
    if (!Object.isExtensible(object)) Object.preventExtensions(guarded)
    return guarded
  }
  if (typeof copy === 'function' && isClass(copy as Callable))
    throw new Error('guardCopy needs a function or an object')
  const guarded = (
    typeof copy === 'function'
      ? guardValue(copy)
      : Object.fromEntries(Object.entries(copy).map(([name, value]) => [name, guardValue(value)]))
  ) as T
  copyFaults.set(guarded, faults)
  return guarded
}

/**
 * Records an engine error that a host caught from the copy before it left a guarded function,
 * for example an HTTP framework's error handler that answers 500 instead of rethrowing.
 */
export function recordCopyFault(copy: object, error: unknown): void {
  const faults = copyFaults.get(copy)
  if (!faults) throw new Error('recordCopyFault needs a copy wrapped by guardCopy')
  const fault = brokenCopyError(error)
  if (fault) faults.push(fault)
}

/**
 * Builds a mutated copy and its unmutated twin with one builder, the only way to obtain an
 * `unmutated` copy. `build` returns a new guarded copy with `mutation` applied, or `identity`
 * (the same change replaced by itself) for the twin, so the two share their bindings.
 */
export async function mutatedPair<T extends object, C>(
  build: (change: C) => T | Promise<T>,
  mutation: C,
  identity: C,
): Promise<{ copy: T; unmutated: T }> {
  const copy = await build(mutation)
  const unmutated = await build(identity)
  const faults = copyFaults.get(copy)
  if (!faults || !copyFaults.has(unmutated) || faults === copyFaults.get(unmutated))
    throw new Error('mutatedPair needs a builder that returns a new guarded copy each time')
  twins.set(copy, unmutated)
  return { copy, unmutated }
}

export interface KillOptions<T> {
  /** Further properties the assertion error must match, for example `actual` and `expected`. */
  outcome?: object
  /**
   * The twin `mutatedPair` built with the copy. When every engine error the mutated copy raised
   * is a property access on undefined or null (a removed guard crashing), the verifier runs
   * again on the twin: if it passes there, the crash came from the mutation and an assertion
   * failure still counts as a kill; if an error recurs, the copy itself is broken. Any other
   * engine error always fails. The rerun proves only the unmutated path: a binding that is
   * undefined and dereferenced only on the mutated path still looks like a removed guard.
   */
  unmutated?: T
}

/**
 * Passes only when the mutation makes a verifier assertion fail over a copy from `guardCopy`.
 * The verifier may be synchronous or return a promise or thenable. Any engine error that left
 * the copy fails as `BrokenSourceCopyError`, even when the verifier caught it, unless the
 * `unmutated` twin shows that the mutation caused it.
 */
export async function expectKilled<T extends object>(
  copy: T,
  verify: (copy: T) => unknown,
  { outcome = {}, unmutated }: KillOptions<T> = {},
): Promise<void> {
  const faults = copyFaults.get(copy)
  if (!faults) throw new Error('expectKilled needs a copy wrapped by guardCopy')
  if (unmutated !== undefined && twins.get(copy) !== unmutated)
    throw new Error('expectKilled needs the unmutated twin that mutatedPair built with the copy')
  let failure: unknown
  try {
    await verify(copy)
  } catch (error) {
    failure = error
  }
  if (faults.length) {
    const fault = faults.find((error) => !removedGuardCrash(error)) ?? faults[0]
    if (unmutated === undefined || !removedGuardCrash(fault)) throw new BrokenSourceCopyError(fault)
    const baseline = copyFaults.get(unmutated) as unknown[]
    let baselineFailure: unknown
    try {
      await verify(unmutated)
    } catch (error) {
      baselineFailure = error
    }
    if (baseline.length) throw new BrokenSourceCopyError(baseline[0], true)
    if (baselineFailure !== undefined)
      throw new Error('the verifier must pass on the unmutated copy', { cause: baselineFailure })
  }
  expect(failure, 'the mutation must make a verifier assertion fail').toMatchObject({
    ...outcome,
    name: 'AssertionError',
  })
}
