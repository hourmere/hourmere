import '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { recurringBookingAdmissionEnabled } from '@hourmere/scheduling'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serviceContext } from './openapi.ts'

const base = {
  DATABASE_URL: 'postgres://hourmere@localhost:5432/hourmere',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
}

describe('recurring booking admission', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('ignores the environment and keeps admission off in every process role', async () => {
    const environments = ['all', 'web', 'worker'].map((HOURMERE_ROLE) => ({
      ...base,
      HOURMERE_ROLE,
    }))
    vi.stubEnv('RECURRING_BOOKINGS_ENABLED', undefined)
    vi.resetModules()
    const { loadConfig } = await import('./config.ts')
    const baseline = environments.map((env) => loadConfig(env))
    vi.stubEnv('RECURRING_BOOKINGS_ENABLED', 'true')
    vi.resetModules()
    const [{ loadConfig: loadWithEnv }, admission] = await Promise.all([
      import('./config.ts'),
      import('@hourmere/scheduling'),
    ])
    expect(environments.map((env) => loadWithEnv(env))).toEqual(baseline)
    expect(
      environments.map((env) => loadWithEnv({ ...env, RECURRING_BOOKINGS_ENABLED: 'true' })),
    ).toEqual(baseline)
    expect(admission.recurringBookingAdmissionEnabled()).toBe(false)
  })

  it('enables admission only for the service receiving the injected dependency', () => {
    const db = {} as Db
    const principal: Principal = {
      kind: 'session',
      sessionId: 'session',
      user: { id: 'host', name: 'Host', email: 'host@example.test' },
      organization: { id: 'org', name: 'Org', slug: 'org', personal: true },
    }
    const enabled = serviceContext({ db, recurringBookingsEnabled: true }, principal)
    expect(recurringBookingAdmissionEnabled(enabled)).toBe(true)
    expect(recurringBookingAdmissionEnabled(serviceContext({ db }, principal))).toBe(false)
    expect(recurringBookingAdmissionEnabled()).toBe(false)
  })

  it('starts from the production entry point without any overrides', async () => {
    vi.stubEnv('RECURRING_BOOKINGS_ENABLED', 'true')
    const stop = new Error('Stop before starting the server')
    const startup = vi.fn(async () => {
      throw stop
    })
    vi.doMock('./server.ts', () => ({ startServer: startup }))
    try {
      await expect(import('./index.ts')).rejects.toBe(stop)
      expect(startup).toHaveBeenCalledExactlyOnceWith()
    } finally {
      vi.doUnmock('./server.ts')
    }
  })
})
