import { describe, expect, it } from 'vitest'
import { templateFailure } from './test-database-global-setup.ts'

describe('migrated test template failure warning', () => {
  const url = 'postgres://hourmere:s3cr%2Ft@db.internal:5432/hourmere'

  it('states the code and message of the failure', () => {
    const error = Object.assign(new Error('database "postgres" does not exist'), { code: '3D000' })
    expect(templateFailure(error, url)).toBe('3D000: database "postgres" does not exist')
  })

  it('removes the connection string and the password from the reason', () => {
    const reason = templateFailure(
      new Error(`connect to ${url} failed: password s3cr/t rejected`),
      url,
    )
    expect(reason).toBe('connect to [redacted] failed: password [redacted] rejected')
  })

  it('removes a percent-encoded password from a URL derived from the server URL', () => {
    const encoded = new URL(url).password
    expect(encoded).not.toBe(decodeURIComponent(encoded))
    const derived = new URL(url)
    derived.pathname = '/postgres'
    const reason = templateFailure(new Error(`connect to ${derived.href} failed`), url)
    expect(reason).not.toContain(encoded)
    expect(reason).not.toContain(decodeURIComponent(encoded))
  })

  it('describes errors that are not Error objects', () => {
    expect(templateFailure('timeout', url)).toBe('timeout')
  })
})
