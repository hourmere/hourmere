import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

const base = {
  DATABASE_URL: 'postgres://hourmere@localhost:5432/hourmere',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
}
const zoom = {
  ZOOM_CLIENT_ID: 'synthetic-client',
  ZOOM_CLIENT_SECRET: 'synthetic-secret',
  CONFERENCE_ENCRYPTION_KEY: Buffer.alloc(32, 19).toString('base64'),
}
describe('independent opt-in Zoom configuration', () => {
  it('is disabled by default and does not add Zoom to sign-in providers', () => {
    expect(loadConfig(base).ZOOM_CLIENT_ID).toBeUndefined()
    const config = loadConfig({ ...base, ...zoom })
    expect(config.ZOOM_CLIENT_ID).toBe('synthetic-client')
    expect(config.GOOGLE_CLIENT_ID).toBeUndefined()
    expect(config.MICROSOFT_CLIENT_ID).toBeUndefined()
  })
  it.each(['ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET', 'CONFERENCE_ENCRYPTION_KEY'] as const)(
    'requires all fields when %s is absent',
    (key) => {
      const values: Record<string, string> = { ...base, ...zoom }
      delete values[key]
      expect(() => loadConfig(values)).toThrow(/Zoom connections require/)
    },
  )
  it('accepts HTTPS or loopback only when enabled', () => {
    for (const PUBLIC_URL of [
      'https://hourmere.example.com',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://[::1]:5173',
    ])
      expect(() => loadConfig({ ...base, ...zoom, PUBLIC_URL })).not.toThrow()
    expect(() => loadConfig({ ...base, ...zoom, PUBLIC_URL: 'http://192.168.1.10' })).toThrow(
      /Zoom connections require HTTPS/,
    )
  })
  it('requires a canonical separate key and never prints malformed secret values', () => {
    for (const CONFERENCE_ENCRYPTION_KEY of [
      'synthetic-private-invalid-key',
      zoom.CONFERENCE_ENCRYPTION_KEY.replace(/=$/, ''),
      Buffer.from(base.BETTER_AUTH_SECRET).toString('base64'),
    ]) {
      expect(() => loadConfig({ ...base, ...zoom, CONFERENCE_ENCRYPTION_KEY })).toThrow()
      expect(() => loadConfig({ ...base, ...zoom, CONFERENCE_ENCRYPTION_KEY })).not.toThrow(
        /synthetic-private-invalid-key/,
      )
    }
    for (const key of ['CALENDAR_ENCRYPTION_KEY', 'WEBHOOK_ENCRYPTION_KEY'])
      expect(() => loadConfig({ ...base, ...zoom, [key]: zoom.CONFERENCE_ENCRYPTION_KEY })).toThrow(
        /independent CONFERENCE_ENCRYPTION_KEY/,
      )
    expect(() =>
      loadConfig({ ...base, ...zoom, ZOOM_CLIENT_SECRET: 'synthetic-secret\nprivate' }),
    ).toThrow(/single-line/)
  })
})
