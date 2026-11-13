// Test support for source-copy mutation controls. A control evaluates a mutated copy of a
// production function and requires a verifier assertion to fail. When the copy itself is broken
// (a missing binding, a binding of the wrong kind, code that does not run), many verifiers turn
// the copy's engine error into an AssertionError (`.resolves`, `.rejects.toMatchObject`, a
// nested `expect(...).toThrow()`), so the broken copy would look like a kill. `guardCopy` records
// those engine errors where they leave the copy, and `expectKilled` turns them into a harness
// failure instead of a kill. It cannot see an engine error the copy swallows or rethrows without
// `cause`, or a wrong binding that raises none; an unmutated-copy test still covers those. A host
// that catches the copy's errors itself (an HTTP framework answering 500) reports them with
// `recordCopyFault`. An engine error that a test's own callback raises while the copy runs it
// leaves through the copy too, so it is reported as a broken copy (a harness failure, never a
// kill).
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

/** A guarded copy, and the copies built `partOf` it: their faults and the wrappers made for them. */
interface Family {
  faults: unknown[]
  /** Each original function or result, mapped to its wrapper. */
  wrappers: WeakMap<object, object>
  /** Each wrapper, mapped to what it wraps. */
  originals: WeakMap<object, object>
}
const families = new WeakMap<object, Family>()
/** Each mutated copy from `mutatedPair`, mapped to its unmutated twin. */
const twins = new WeakMap<object, object>()
/** Every wrapper any guard made: it is never wrapped again. */
const wrappers = new WeakSet<object>()

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

/** A plain object, a null-prototype object (a module namespace) or an array. */
const isPlain = (value: unknown): value is object => {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return (
    prototype === Object.prototype ||
    prototype === null ||
    (prototype === Array.prototype && Array.isArray(value))
  )
}

/** Whether a plain value holds copy code: a function or accessor, here or in a nested plain value. */
const carriesCode = (value: object, seen = new Set<object>()): boolean => {
  seen.add(value)
  return Reflect.ownKeys(value).some((key) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (!descriptor) return false
    if (!('value' in descriptor)) return true
    const member: unknown = descriptor.value
    return (
      typeof member === 'function' ||
      (isPlain(member) && !seen.has(member) && carriesCode(member, seen))
    )
  })
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
 * rejected thenables are both recorded.
 *
 * What a guarded function returns or resolves to is part of the copy too:
 * - a returned function is guarded the same way;
 * - a plain object, null-prototype object or array that holds copy code (a function or an
 *   accessor, directly or in a nested plain value) is returned as a proxy over the copy's own
 *   object. Reads go to that object, so state the copy changes later is seen, and every function
 *   read through the proxy, from a data member, a getter or a nested plain value, is guarded. A
 *   getter or setter that raises an engine error is recorded. A frozen result cannot change, so
 *   it is returned as a frozen copy whose functions and accessors are guarded. A read-only,
 *   non-configurable function member of a result that is not frozen cannot be guarded: reading it
 *   raises a harness TypeError, recorded like any other fault;
 * - class instances (including Response, Date and Map) and data are returned as they are, since a
 *   proxy would break private fields and brand checks: their methods are not guarded.
 *
 * A wrapper that comes back into its own copy (as `this`, a direct argument or a value assigned
 * through a proxy) is unwrapped, so the copy sees its own object. A wrapper from another copy is
 * passed as it is, so it keeps recording that copy's faults; a returned wrapper is never wrapped
 * again.
 */
export function guardCopy<T extends object>(copy: T, { partOf }: GuardOptions = {}): T {
  const family: Family | undefined =
    partOf === undefined
      ? { faults: [], wrappers: new WeakMap(), originals: new WeakMap() }
      : families.get(partOf)
  if (!family) throw new Error('guardCopy needs `partOf` to be a copy wrapped by guardCopy')
  const record = (error: unknown): never => {
    const fault = brokenCopyError(error)
    if (fault) family.faults.push(fault)
    throw error
  }
  const unwrap = (value: unknown) => family.originals.get(value as object) ?? value
  const remember = <W extends object>(original: object, wrapper: W): W => {
    family.wrappers.set(original, wrapper)
    family.originals.set(wrapper, original)
    wrappers.add(wrapper)
    return wrapper
  }
  const guardFunction = (run: Callable) => {
    const guarded = remember(run, function guarded(this: unknown, ...args: unknown[]) {
      let result: unknown
      try {
        result = Reflect.apply(run, unwrap(this), args.map(unwrap))
      } catch (error) {
        return record(error)
      }
      return typeof (result as PromiseLike<unknown> | undefined)?.then === 'function'
        ? Promise.resolve(result).then(guardValue, record)
        : guardValue(result)
    })
    for (const [name, member] of Object.entries(run))
      Object.assign(guarded, {
        [name]: typeof member === 'function' ? guardValue(member) : member,
      })
    return guarded
  }
  const guardFrozen = (original: object) => {
    const frozen = remember(
      original,
      Array.isArray(original) ? [] : Object.create(Object.getPrototypeOf(original)),
    )
    const descriptors = Object.getOwnPropertyDescriptors(original) as Record<
      PropertyKey,
      PropertyDescriptor
    >
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key] as PropertyDescriptor
      if ('value' in descriptor) descriptor.value = guardValue(descriptor.value)
      if (descriptor.get) descriptor.get = guardValue(descriptor.get) as () => unknown
      if (descriptor.set) descriptor.set = guardValue(descriptor.set) as (value: unknown) => void
    }
    return Object.freeze(Object.defineProperties(frozen, descriptors))
  }
  const guardResult = (original: object) =>
    remember(
      original,
      new Proxy(original, {
        get(target, key, receiver) {
          const own = Reflect.getOwnPropertyDescriptor(target, key)
          // Inherited members come from Object.prototype or Array.prototype.
          if (!own) return Reflect.get(target, key, receiver)
          let value: unknown
          try {
            value = Reflect.get(target, key, unwrap(receiver))
          } catch (error) {
            return record(error)
          }
          const guarded = guardValue(value)
          if (guarded !== value && own.configurable === false && own.writable === false)
            return record(
              new TypeError(
                `guardCopy cannot guard ${String(key)}, a read-only member of a result that is not frozen`,
              ),
            )
          return guarded
        },
        set(target, key, value, receiver) {
          try {
            return Reflect.set(target, key, unwrap(value), unwrap(receiver))
          } catch (error) {
            return record(error)
          }
        },
      }),
    )
  const guardValue = (value: unknown): unknown => {
    if (wrappers.has(value as object)) return value
    const known = family.wrappers.get(value as object)
    if (known) return known
    if (typeof value === 'function')
      return isClass(value as Callable) ? value : guardFunction(value as Callable)
    if (!isPlain(value) || !carriesCode(value)) return value
    return Object.isFrozen(value) ? guardFrozen(value) : guardResult(value)
  }
  if (typeof copy === 'function' && isClass(copy as Callable))
    throw new Error('guardCopy needs a function or an object')
  const guarded = (
    typeof copy === 'function'
      ? guardValue(copy)
      : Object.fromEntries(Object.entries(copy).map(([name, value]) => [name, guardValue(value)]))
  ) as T
  families.set(guarded, family)
  return guarded
}

/**
 * Records an engine error that a host caught from the copy before it left a guarded function,
 * for example an HTTP framework's error handler that answers 500 instead of rethrowing.
 */
export function recordCopyFault(copy: object, error: unknown): void {
  const family = families.get(copy)
  if (!family) throw new Error('recordCopyFault needs a copy wrapped by guardCopy')
  const fault = brokenCopyError(error)
  if (fault) family.faults.push(fault)
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
  const family = families.get(copy)
  if (!family || !families.has(unmutated) || family === families.get(unmutated))
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
  const faults = families.get(copy)?.faults
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
    const baseline = (families.get(unmutated) as Family).faults
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
