import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupTestDatabases, registerTestDatabaseCleanup } from './test-database-registry.ts'

describe('lightweight test database registry', () => {
  const unregister: (() => void)[] = []

  afterEach(() => {
    for (const remove of unregister.splice(0)) remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('tries every owner even when a callback throws synchronously', async () => {
    const throwing = vi.fn(() => {
      throw new Error('private driver details')
    })
    const remaining = vi.fn(async () => {})
    unregister.push(registerTestDatabaseCleanup(throwing), registerTestDatabaseCleanup(remaining))
    await expect(cleanupTestDatabases()).rejects.toThrow('Test database cleanup failed')
    expect(remaining).toHaveBeenCalledOnce()
  })

  it('suppresses cleanup failures when the parent disconnects', async () => {
    const count = process.listenerCount('disconnect')
    const drop = vi.fn(async () => {
      throw new Error('private driver details')
    })
    const log = vi.spyOn(console, 'error')
    unregister.push(registerTestDatabaseCleanup(drop))
    expect(process.listenerCount('disconnect')).toBe(count + 1)
    const listener = process.listeners('disconnect').at(-1)
    expect(listener).toBeTypeOf('function')
    expect(() => listener?.()).not.toThrow()
    await vi.waitFor(() => {
      expect(drop).toHaveBeenCalledOnce()
      expect(process.listenerCount('disconnect')).toBe(count)
    })
    expect(log).not.toHaveBeenCalled()
  })

  it('stops waiting for disconnected worker cleanup after fifteen seconds', async () => {
    vi.useFakeTimers()
    const count = process.listenerCount('disconnect')
    unregister.push(registerTestDatabaseCleanup(() => new Promise(() => {})))
    process.listeners('disconnect').at(-1)?.()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(process.listenerCount('disconnect')).toBe(count + 1)
    await vi.advanceTimersByTimeAsync(1)
    expect(process.listenerCount('disconnect')).toBe(count)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not reject into a disconnected fork when its cleanup fails', async () => {
    const source = `
      import { registerTestDatabaseCleanup } from ${JSON.stringify(new URL('./test-database-registry.ts', import.meta.url).href)};
      registerTestDatabaseCleanup(async () => { throw new Error('fixture failure'); });
      process.on('disconnect', () => { setTimeout(() => {}, 20); });
      process.stdout.write('ready\\n');
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const exited = once(child, 'exit')
    let errors = ''
    child.stderr?.on('data', (chunk) => {
      errors += String(chunk)
    })
    try {
      await once(child.stdout as NodeJS.ReadableStream, 'data')
      child.disconnect()
      expect(await exited).toEqual([0, null])
      expect(errors).toBe('')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }
  })

  it('also cleans fixtures registered after the parent has already disconnected', async () => {
    const source = `
      import { registerTestDatabaseCleanup } from ${JSON.stringify(new URL('./test-database-registry.ts', import.meta.url).href)};
      const deadline = setTimeout(() => process.exit(1), 2000);
      const unregister = registerTestDatabaseCleanup(async () => {
        unregister();
        setTimeout(() => {
          const unregisterLate = registerTestDatabaseCleanup(async () => {
            unregisterLate();
            clearTimeout(deadline);
            process.stdout.write('late fixture cleaned\\n');
          });
        }, 10);
      });
      process.stdout.write('ready\\n');
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const exited = once(child, 'exit')
    let output = ''
    child.stdout?.on('data', (chunk) => {
      output += String(chunk)
    })
    try {
      await once(child.stdout as NodeJS.ReadableStream, 'data')
      child.disconnect()
      expect(await exited).toEqual([0, null])
      expect(output).toContain('late fixture cleaned')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }
  })
})

import { spawn } from 'node:child_process'
import { once } from 'node:events'
