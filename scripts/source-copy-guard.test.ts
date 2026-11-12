import { describe, expect, it } from 'vitest'
import {
  BrokenSourceCopyError,
  expectKilled,
  guardCopy,
  mutatedPair,
  recordCopyFault,
} from './source-copy-guard.ts'

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
  const verifyRefusal = (copy: { validate: (value: undefined) => unknown }) => {
    expect(() => copy.validate(undefined)).toThrow('unknown_question')
  }

  const validatorPair = (mutated: (guarded: boolean) => ReturnType<typeof validator> = validator) =>
    mutatedPair((guarded: boolean) => (guarded ? validator(true) : mutated(false)), false, true)

  it('counts a mutation-caused engine error as a kill when the unmutated twin passes', async () => {
    const { copy, unmutated } = await validatorPair()
    await expect(expectKilled(copy, verifyRefusal, { unmutated })).resolves.toBeUndefined()
    await expect(expectKilled(validator(false), verifyRefusal)).rejects.toMatchObject(brokenCopy)
  })

  it('still reports a broken copy when the unmutated twin raises the error too', async () => {
    const { copy, unmutated } = await mutatedPair(
      () =>
        guardCopy({
          validate: (value: { type: string } | undefined) => (value as { type: string }).type,
        }),
      'mutated',
      'identity',
    )
    await expect(expectKilled(copy, verifyRefusal, { unmutated })).rejects.toMatchObject({
      name: 'BrokenSourceCopyError',
      message: expect.stringContaining('unmutated source copy raised TypeError'),
    })
  })

  it('never excuses an unbound name, even when the unmutated twin passes', async () => {
    const unbound = () =>
      guardCopy({
        validate: (value: { type: string } | undefined) => {
          if (value === undefined) throw new ReferenceError('unbound is not defined')
          return value.type
        },
      })
    const { copy, unmutated } = await validatorPair(unbound)
    await expect(expectKilled(copy, verifyRefusal, { unmutated })).rejects.toMatchObject({
      name: 'BrokenSourceCopyError',
      message: expect.stringContaining('The source copy raised ReferenceError'),
    })
  })

  it('never excuses a binding of the wrong kind reached only on the mutated path', async () => {
    // The mutation removes a refusal that the real dependency repeats, so with a working
    // binding it survives; a binding of the wrong kind must not turn it into a kill.
    const build = (refuses: boolean, dependency: unknown) =>
      guardCopy({
        validate: (value: string | undefined) => {
          if (refuses && value === undefined) throw new Error('unknown_question')
          return (dependency as (value: string | undefined) => string)(value)
        },
      })
    const real = (value: string | undefined) => {
      if (value === undefined) throw new Error('unknown_question')
      return value
    }
    const survivor = await mutatedPair((refuses: boolean) => build(refuses, real), false, true)
    await expect(
      expectKilled(survivor.copy, verifyRefusal, { unmutated: survivor.unmutated }),
    ).rejects.toThrow('the mutation must make a verifier assertion fail')
    const wrongKind = await mutatedPair((refuses: boolean) => build(refuses, {}), false, true)
    await expect(
      expectKilled(wrongKind.copy, verifyRefusal, { unmutated: wrongKind.unmutated }),
    ).rejects.toMatchObject({
      name: 'BrokenSourceCopyError',
      message: expect.stringContaining('dependency is not a function'),
    })
  })

  it('refuses an unmutated copy that is not the twin built by the same builder', async () => {
    const { copy, unmutated } = await validatorPair()
    await expect(expectKilled(copy, verifyRefusal, { unmutated: validator(true) })).rejects.toThrow(
      'the unmutated twin that mutatedPair built',
    )
    await expect(expectKilled(copy, verifyRefusal, { unmutated: copy })).rejects.toThrow(
      'the unmutated twin that mutatedPair built',
    )
    await expect(expectKilled(validator(false), verifyRefusal, { unmutated })).rejects.toThrow(
      'the unmutated twin that mutatedPair built',
    )
    const shared = validator(true)
    await expect(mutatedPair(() => shared, false, true)).rejects.toThrow(
      'a new guarded copy each time',
    )
    await expect(
      mutatedPair(
        (guarded: boolean) => (guarded ? { validate: () => 'x' } : validator(false)),
        false,
        true,
      ),
    ).rejects.toThrow('a new guarded copy each time')
  })

  it('refuses an unmutated twin that fails the verifier without an engine error', async () => {
    const { copy, unmutated } = await mutatedPair(
      (guarded: boolean) =>
        guarded ? guardCopy({ validate: () => 'accepted' }) : validator(false),
      false,
      true,
    )
    await expect(expectKilled(copy, verifyRefusal, { unmutated })).rejects.toThrow(
      'the verifier must pass on the unmutated copy',
    )
  })

  it('still requires an assertion failure after the unmutated twin passes', async () => {
    // A verifier that accepts any throw tolerates the crash: the mutation survives.
    const tolerant = (copy: ReturnType<typeof validator>) => {
      expect(() => copy.validate(undefined)).toThrow()
    }
    const { copy, unmutated } = await validatorPair()
    await expect(expectKilled(copy, tolerant, { unmutated })).rejects.toThrow(
      'the mutation must make a verifier assertion fail',
    )
  })

  it('never excuses an unbound name recorded after an excusable crash', async () => {
    const mixed = () => {
      let calls = 0
      return guardCopy({
        validate: (value: { type: string } | undefined) => {
          calls += 1
          if (calls === 1) return (value as { type: string }).type
          throw new ReferenceError('unbound is not defined')
        },
      })
    }
    const verifyTwice = (copy: { validate: (value: undefined) => unknown }) => {
      const messages = [0, 1].map(() => {
        try {
          copy.validate(undefined)
        } catch (error) {
          return (error as Error).message
        }
        return 'accepted'
      })
      expect(messages).toEqual(['unknown_question', 'unknown_question'])
    }
    const { copy, unmutated } = await validatorPair(mixed)
    await expect(expectKilled(copy, verifyTwice, { unmutated })).rejects.toMatchObject({
      name: 'BrokenSourceCopyError',
      message: expect.stringContaining('ReferenceError'),
    })
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
  it('forwards `this` to the copied function', () => {
    const copy = guardCopy({
      base: 2,
      scaled(this: { base: number }, factor: number) {
        return this.base * factor
      },
    })
    expect(copy.scaled(3)).toBe(6)
  })

  // A factory's result: the access object that `teamManagementAccess(db, caller)` returns.
  const factory = (fault?: Error) =>
    guardCopy({
      access: () => ({
        limit: 3,
        write(this: { limit: number }, value: number) {
          if (fault) throw fault
          return Math.min(value, this.limit)
        },
        async read() {
          if (fault) throw fault
          return 'read'
        },
      }),
      handler: () => async () => {
        if (fault) throw fault
        return 'handled'
      },
      load: async () => ({ run: () => (fault ? Promise.reject(fault) : 'ran') }),
      row: () => ({ id: 1 }),
      instance: () => new Date(0),
    })

  it('guards the functions that a copied factory returns or resolves to', async () => {
    const working = factory()
    const access = working.access()
    expect(access.write(5)).toBe(3)
    expect(access.limit).toBe(3)
    await expect(access.read()).resolves.toBe('read')
    await expect(working.handler()()).resolves.toBe('handled')
    expect((await working.load()).run()).toBe('ran')
    await expect(
      expectKilled(working, (copy) => expect(copy.access().write(5)).toBe(5)),
    ).resolves.toBeUndefined()
    for (const [label, verify] of [
      [
        'a returned object',
        (copy: typeof working) => expect(() => copy.access().write(1)).toThrow(),
      ],
      [
        'an async method of a returned object',
        (copy: typeof working) => expect(copy.access().read()).rejects.toThrow(),
      ],
      ['a returned function', (copy: typeof working) => expect(copy.handler()()).rejects.toThrow()],
      [
        'a resolved object',
        async (copy: typeof working) => expect((await copy.load()).run()).rejects.toThrow(),
      ],
    ] as const) {
      const broken = factory(new TypeError('check is not a function'))
      await expect(
        expectKilled(broken, async (copy) => {
          await verify(copy)
          expect.fail(label)
        }),
        label,
      ).rejects.toMatchObject(brokenCopy)
    }
  })

  it('leaves data, class instances and repeated results as they are', () => {
    const copy = factory()
    expect(copy.row()).toEqual({ id: 1 })
    expect(copy.instance()).toBeInstanceOf(Date)
    const result = { run: () => 1 }
    const repeated = guardCopy({ same: () => result })
    expect(repeated.same()).toBe(repeated.same())
    expect(repeated.same()).not.toBe(result)
    const frozen = guardCopy({ make: () => Object.freeze({ run: () => 1 }) }).make()
    expect(Object.isExtensible(frozen)).toBe(false)
    expect(frozen.run()).toBe(1)
  })

  it('records the faults of a copy built as part of another', async () => {
    const control = guardCopy({ run: () => 'accepted' })
    const helper = guardCopy(
      {
        crash: () => {
          throw new ReferenceError('unbound is not defined')
        },
      },
      { partOf: control },
    )
    await expect(
      expectKilled(control, (copy) => {
        expect(() => helper.crash()).toThrow()
        expect(copy.run()).toBe('rejected')
      }),
    ).rejects.toMatchObject(brokenCopy)
    expect(() => guardCopy({ run: () => 1 }, { partOf: { run: () => 1 } })).toThrow(
      'guardCopy needs `partOf`',
    )
  })

  it('records an engine error that a host caught from the copy', async () => {
    const copy = guardCopy({ status: () => 500 })
    recordCopyFault(copy, new Error('domain refusal'))
    await expect(
      expectKilled(copy, (module) => expect(module.status()).toBe(200)),
    ).resolves.toBeUndefined()
    recordCopyFault(
      copy,
      new Error('handler failed', { cause: new TypeError('x is not a function') }),
    )
    await expect(
      expectKilled(copy, (module) => expect(module.status()).toBe(200)),
    ).rejects.toMatchObject(brokenCopy)
    expect(() => recordCopyFault({}, new TypeError('x'))).toThrow('recordCopyFault needs a copy')
  })
})
