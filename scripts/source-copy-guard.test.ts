import { describe, expect, it } from 'vitest'
import { BrokenSourceCopyError, expectKilled, guardCopy } from './source-copy-guard.ts'

// A verifier like the database ones: `.resolves` turns any rejection into an AssertionError.
const verifyResolves = async (copy: { run: () => unknown }) => {
  await expect(Promise.resolve().then(() => copy.run())).resolves.toBeDefined()
}
// A synchronous verifier like the validator ones: `toThrowError()` accepts any thrown error.
const verifyThrows = (copy: { run: () => unknown }) => {
  expect(() => copy.run()).toThrowError()
}
const brokenCopy = { name: 'BrokenSourceCopyError' }

describe('source copy guard', () => {
  it.each<[string, () => unknown]>([
    [
      'a synchronous TypeError',
      () => {
        throw new TypeError('bindings.select is not a function')
      },
    ],
    [
      'a SyntaxError',
      async () => {
        throw new SyntaxError('Unexpected token')
      },
    ],
    [
      'a ReferenceError wrapped as a cause',
      async () => {
        throw new Error('Could not book', { cause: new ReferenceError('unbound is not defined') })
      },
    ],
    [
      'a rejected thenable',
      () => ({
        // biome-ignore lint/suspicious/noThenProperty: a non-native thenable on purpose
        then: (_: unknown, reject: (error: unknown) => void) =>
          reject(new ReferenceError('unbound is not defined')),
      }),
    ],
  ])('reports %s from the copy as a broken copy', async (_, run) => {
    await expect(expectKilled(guardCopy({ run }), verifyResolves)).rejects.toMatchObject(brokenCopy)
  })

  it('reports an engine error that a synchronous verifier accepted as any throw', async () => {
    const run = () => {
      throw new ReferenceError('unbound is not defined')
    }
    const failure = expectKilled(guardCopy({ run }), verifyThrows)
    await expect(failure).rejects.toBeInstanceOf(BrokenSourceCopyError)
    await expect(failure).rejects.toMatchObject({
      message: expect.stringContaining('ReferenceError: unbound is not defined'),
      cause: expect.any(ReferenceError),
    })
  })

  it('reports an engine error even when the verifier catches it itself', async () => {
    const copy = guardCopy({
      run: () => {
        throw new TypeError('reason is not a function')
      },
    })
    const verify = (module: typeof copy) => {
      try {
        module.run()
      } catch {
        expect.fail('the copy threw')
      }
    }
    await expect(expectKilled(copy, verify)).rejects.toMatchObject(brokenCopy)
  })

  it('names both causes of an engine error in the harness message', async () => {
    const run = () => {
      throw new TypeError('Did not provide any valid Duration fields')
    }
    await expect(expectKilled(guardCopy({ run }), verifyResolves)).rejects.toMatchObject({
      message: expect.stringMatching(/copy is broken.*mutation crashes the code/s),
    })
  })

  // A mutation that removes a guard can make the code crash where it used to refuse an input.
  const validator = (guarded: boolean) =>
    guardCopy({
      validate: (value: { type: string } | undefined) => {
        if (guarded && value === undefined) throw new Error('unknown_question')
        return (value as { type: string }).type
      },
    })
  const verifyRefusal = (copy: ReturnType<typeof validator>) => {
    expect(() => copy.validate(undefined)).toThrow('unknown_question')
  }

  it('counts a mutation-caused engine error as a kill when the unmutated copy passes', async () => {
    await expect(
      expectKilled(validator(false), verifyRefusal, { unmutated: validator(true) }),
    ).resolves.toBeUndefined()
    await expect(expectKilled(validator(false), verifyRefusal)).rejects.toMatchObject(brokenCopy)
  })

  it('still reports a broken copy when the unmutated copy raises the error too', async () => {
    const broken = () =>
      guardCopy({
        validate: () => {
          throw new TypeError('bindings.validate is not a function')
        },
      })
    await expect(
      expectKilled(broken(), verifyRefusal, { unmutated: broken() }),
    ).rejects.toMatchObject({
      name: 'BrokenSourceCopyError',
      message: expect.stringContaining('unmutated source copy raised TypeError'),
    })
  })

  it('never excuses an unbound name, even when the unmutated copy passes', async () => {
    const unbound = guardCopy({
      validate: (value: { type: string } | undefined) => {
        if (value === undefined) throw new ReferenceError('unbound is not defined')
        return value.type
      },
    })
    await expect(
      expectKilled(unbound, verifyRefusal, { unmutated: validator(true) }),
    ).rejects.toMatchObject({
      name: 'BrokenSourceCopyError',
      message: expect.stringContaining('The source copy raised ReferenceError'),
    })
  })

  it('refuses an unmutated copy that fails the verifier or is not separate and guarded', async () => {
    await expect(
      expectKilled(validator(false), verifyRefusal, { unmutated: validator(false) }),
    ).rejects.toMatchObject(brokenCopy)
    const wrong = guardCopy({ validate: () => 'accepted' })
    await expect(
      expectKilled(validator(false), verifyRefusal, { unmutated: wrong }),
    ).rejects.toThrow('the verifier must pass on the unmutated copy')
    const copy = validator(false)
    await expect(expectKilled(copy, verifyRefusal, { unmutated: copy })).rejects.toThrow(
      'separate unmutated copy',
    )
    await expect(
      expectKilled(validator(true), verifyRefusal, { unmutated: { validate: () => 'x' } }),
    ).rejects.toThrow('separate unmutated copy')
  })

  it('counts an assertion failure over a working copy as a kill', async () => {
    const run = async () => {
      throw new Error('This time is not available')
    }
    await expect(expectKilled(guardCopy({ run }), verifyResolves)).resolves.toBeUndefined()
  })

  it('counts a synchronous assertion failure as a kill', async () => {
    const copy = guardCopy({ run: () => 'accepted' })
    await expect(
      expectKilled(copy, (module) => expect(module.run()).toBeUndefined()),
    ).resolves.toBeUndefined()
  })

  it('accepts a verifier that returns a thenable', async () => {
    const copy = guardCopy({ run: () => 'accepted' })
    const verify = (module: typeof copy) => ({
      // biome-ignore lint/suspicious/noThenProperty: a non-native thenable on purpose
      then: (resolve: () => void, reject: (error: unknown) => void) => {
        try {
          expect(module.run()).toBeUndefined()
          resolve()
        } catch (error) {
          reject(error)
        }
      },
    })
    await expect(expectKilled(copy, verify)).resolves.toBeUndefined()
  })

  it('refuses a surviving mutation and a failure that is not an assertion', async () => {
    const copy = guardCopy({ run: () => 'accepted' })
    await expect(expectKilled(copy, (module) => module.run())).rejects.toThrow(
      'the mutation must make a verifier assertion fail',
    )
    await expect(
      expectKilled(copy, () => {
        throw new RangeError('Invalid time value')
      }),
    ).rejects.toThrow('the mutation must make a verifier assertion fail')
  })

  it('requires the assertion failure to match the given outcome', async () => {
    const copy = guardCopy({ run: () => 2 })
    const verify = (module: typeof copy) => expect(module.run()).toBe(1)
    await expect(
      expectKilled(copy, verify, { outcome: { actual: 2, expected: 1 } }),
    ).resolves.toBeUndefined()
    await expect(expectKilled(copy, verify, { outcome: { actual: 3 } })).rejects.toThrow(
      'the mutation must make a verifier assertion fail',
    )
  })

  it('guards a copy that is a single function', async () => {
    const copy = () => guardCopy((value: unknown) => (value as { at: () => unknown }).at())
    expect(() => copy()(null)).toThrow(TypeError)
    await expect(
      expectKilled(copy(), (run) => expect(() => run(null)).toThrowError()),
    ).rejects.toMatchObject(brokenCopy)
  })

  it('guards the functions attached to a function copy', async () => {
    const deliver = Object.assign(() => 'sent', {
      worker: () => {
        throw new ReferenceError('unbound is not defined')
      },
      retries: 3,
    })
    const copy = guardCopy(deliver)
    expect(copy()).toBe('sent')
    expect(copy.retries).toBe(3)
    await expect(
      expectKilled(copy, (module) => expect(() => module.worker()).toThrowError()),
    ).rejects.toMatchObject(brokenCopy)
  })

  it('passes classes and other exports through untouched', async () => {
    class CopyError extends Error {}
    const limits = [1, 2]
    const copy = guardCopy({ CopyError, limits, mode: 'strict', fail: () => new CopyError() })
    expect(copy.CopyError).toBe(CopyError)
    expect(copy.limits).toBe(limits)
    expect(copy.mode).toBe('strict')
    expect(new copy.CopyError()).toBeInstanceOf(CopyError)
    expect(copy.fail()).toBeInstanceOf(copy.CopyError)
    expect(() => guardCopy(CopyError)).toThrow('guardCopy needs a function or an object')
  })

  it('refuses a copy that was not guarded', async () => {
    await expect(expectKilled({ run: () => 1 }, verifyResolves)).rejects.toThrow(
      'expectKilled needs a copy',
    )
  })
})
