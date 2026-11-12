// Test support for source-copy mutation controls. A control evaluates a mutated copy of a
// production function and requires a verifier assertion to fail. When the copy itself is broken
// (a missing binding, a binding of the wrong kind, code that does not run), many verifiers turn
// the copy's engine error into an AssertionError (`.resolves`, `.rejects.toMatchObject`, a
// nested `expect(...).toThrow()`), so the broken copy would look like a kill. `guardCopy` records
// those engine errors where they leave the copy, and `expectKilled` turns them into a harness
// failure instead of a kill. It cannot see an engine error the copy swallows or rethrows without
// `cause`, or a wrong binding that raises none; an unmutated-copy test still covers those.
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

/** The first engine error in `error` or its `cause` chain, if any. */
export function brokenCopyError(error: unknown): unknown {
  for (let current = error, depth = 0; current instanceof Error && depth < 8; depth += 1) {
    if (BROKEN_COPY_ERRORS.some((type) => current instanceof type)) return current
    current = current.cause
  }
  return undefined
}

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
            'crashes the code instead of failing an assertion. Pass the unmutated copy as ' +
            '`unmutated` to tell the two apart.',
      { cause: fault },
    )
  }
}

type Callable = (...args: unknown[]) => unknown

const isClass = (value: Callable) => /^class\b/.test(Function.prototype.toString.call(value))

/**
 * Wraps the copy's functions so that every engine error escaping one of them is recorded, then
 * rethrown unchanged. Accepts an object of exports (for example a module namespace) or a single
 * function, whose own properties count as further exports. Classes and non-function exports pass
 * through untouched, so `instanceof`, `new` and constants keep working. Synchronous throws and
 * rejected thenables are both recorded. Only these boundaries are guarded: an engine error that
 * escapes an object returned by a copied factory is not seen.
 */
export function guardCopy<T extends object>(copy: T): T {
  const faults: unknown[] = []
  const record = (error: unknown): never => {
    const fault = brokenCopyError(error)
    if (fault) faults.push(fault)
    throw error
  }
  const guard = (run: Callable) =>
    function guarded(this: unknown, ...args: unknown[]) {
      try {
        const result = Reflect.apply(run, this, args)
        return typeof (result as PromiseLike<unknown> | undefined)?.then === 'function'
          ? Promise.resolve(result).catch(record)
          : result
      } catch (error) {
        return record(error)
      }
    }
  if (typeof copy === 'function' && isClass(copy as Callable))
    throw new Error('guardCopy needs a function or an object')
  const exports = Object.fromEntries(
    Object.entries(copy).map(([name, value]) => [
      name,
      typeof value === 'function' && !isClass(value) ? guard(value) : value,
    ]),
  )
  const guarded = (
    typeof copy === 'function' ? Object.assign(guard(copy as Callable), exports) : exports
  ) as T
  copyFaults.set(guarded, faults)
  return guarded
}

export interface KillOptions<T> {
  /** Further properties the assertion error must match, for example `actual` and `expected`. */
  outcome?: object
  /**
   * A guarded copy without the mutation. When the mutated copy raises only TypeErrors, the
   * verifier runs again on this copy: if it passes there, the mutation made the code crash and
   * an assertion failure still counts as a kill; if the error recurs, the copy itself is broken.
   * A ReferenceError or SyntaxError always fails: no valid mutation raises one.
   */
  unmutated?: T
}

/**
 * Passes only when the mutation makes a verifier assertion fail over a copy from `guardCopy`.
 * The verifier may be synchronous or return a promise or thenable. Any engine error that left
 * the copy fails as `BrokenSourceCopyError`, even when the verifier caught it, unless the
 * `unmutated` copy shows that the mutation caused it.
 */
export async function expectKilled<T extends object>(
  copy: T,
  verify: (copy: T) => unknown,
  { outcome = {}, unmutated }: KillOptions<T> = {},
): Promise<void> {
  const faults = copyFaults.get(copy)
  if (!faults) throw new Error('expectKilled needs a copy wrapped by guardCopy')
  const baseline = unmutated === undefined ? [] : copyFaults.get(unmutated)
  if (!baseline || unmutated === copy)
    throw new Error('expectKilled needs a separate unmutated copy wrapped by guardCopy')
  let failure: unknown
  try {
    await verify(copy)
  } catch (error) {
    failure = error
  }
  if (faults.length) {
    const fault = faults.find((error) => !(error instanceof TypeError)) ?? faults[0]
    if (unmutated === undefined || !(fault instanceof TypeError))
      throw new BrokenSourceCopyError(fault)
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
