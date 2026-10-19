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
    expect(loadConfig({ ...base, ...zoom }).ZOOM_MEETINGS_ENABLED).toBe(false)
    expect(
      loadConfig({ ...base, ...zoom, ZOOM_MEETINGS_ENABLED: 'true' }).ZOOM_MEETINGS_ENABLED,
    ).toBe(true)
    expect(() => loadConfig({ ...base, ZOOM_MEETINGS_ENABLED: 'true' })).toThrow(
      /separately configured Zoom/,
    )
    expect(() => loadConfig({ ...base, ...zoom, ZOOM_MEETINGS_ENABLED: '1' })).toThrow()
    const config = loadConfig({ ...base, ...zoom })
    expect(config.ZOOM_CLIENT_ID).toBe('synthetic-client')
    expect(config.GOOGLE_CLIENT_ID).toBeUndefined()
    expect(config.MICROSOFT_CLIENT_ID).toBeUndefined()
  })
  it('enables webhook verification independently of OAuth and automatic meetings', () => {
    expect(() => loadConfig(base)).not.toThrow()
    expect(() => loadConfig({ ...base, ZOOM_WEBHOOK_SECRET_TOKEN: '' })).not.toThrow()
    expect(loadConfig(base).ZOOM_WEBHOOK_SECRET_TOKEN).toBeUndefined()
    expect(
      loadConfig({ ...base, ZOOM_WEBHOOK_SECRET_TOKEN: '' }).ZOOM_WEBHOOK_SECRET_TOKEN,
    ).toBeUndefined()
    const config = loadConfig({ ...base, ZOOM_WEBHOOK_SECRET_TOKEN: 'synthetic-webhook-secret' })
    expect(config.ZOOM_WEBHOOK_SECRET_TOKEN === 'synthetic-webhook-secret').toBe(true)
    expect(config.ZOOM_CLIENT_ID).toBeUndefined()
    expect(config.ZOOM_MEETINGS_ENABLED).toBe(false)
    expect(
      loadConfig({ ...base, ...zoom, ZOOM_WEBHOOK_SECRET_TOKEN: 'synthetic-webhook-secret' })
        .ZOOM_WEBHOOK_SECRET_TOKEN === 'synthetic-webhook-secret',
    ).toBe(true)
  })
  it.each([
    ' ',
    'synthetic-private-webhook\nsecret',
    'synthetic-private-webhook secret',
    'synthetic-private-webhook\u0000secret',
    'synthetic-private-webhook\ud800secret',
    'x'.repeat(1025),
  ])(
    'rejects malformed webhook secret tokens without printing them (%#)',
    (ZOOM_WEBHOOK_SECRET_TOKEN) => {
      let message = ''
      try {
        loadConfig({ ...base, ZOOM_WEBHOOK_SECRET_TOKEN })
      } catch (error) {
        message = error instanceof Error ? error.message : ''
      }
      expect(message).toContain('ZOOM_WEBHOOK_SECRET_TOKEN')
      if (ZOOM_WEBHOOK_SECRET_TOKEN.trim())
        expect(message.includes(ZOOM_WEBHOOK_SECRET_TOKEN)).toBe(false)
    },
  )
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
