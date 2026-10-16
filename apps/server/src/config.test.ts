import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

const base = {
  DATABASE_URL: 'postgres://hourmere@localhost:5432/hourmere',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
}

describe('loadConfig', () => {
  it('accepts the minimal configuration', () => {
    const c = loadConfig(base)
    expect(c.PUBLIC_URL).toBe('http://localhost:3000')
    expect(c.SMTP_URL).toBeUndefined()
    expect(c.socialProviders).toEqual({})
  })

  it('requires BETTER_AUTH_SECRET and says how to make one', () => {
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(
      /BETTER_AUTH_SECRET is required.*openssl rand -base64 32/,
    )
  })

  it('rejects a BETTER_AUTH_SECRET shorter than 32 characters', () => {
    expect(() => loadConfig({ ...base, BETTER_AUTH_SECRET: 'a'.repeat(31) })).toThrow(
      /BETTER_AUTH_SECRET must be at least 32 characters/,
    )
  })

  it('treats empty variables (as docker compose passes them) as unset', () => {
    const c = loadConfig({
      ...base,
      SMTP_URL: '',
      MAIL_FROM: '',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
    })
    expect(c.SMTP_URL).toBeUndefined()
    expect(c.socialProviders).toEqual({})
  })

  it('uses PUBLIC_URL as an origin and rejects paths', () => {
    expect(loadConfig({ ...base, PUBLIC_URL: 'https://cal.example.com/' }).PUBLIC_URL).toBe(
      'https://cal.example.com',
    )
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'https://example.com/hourmere' })).toThrow(
      /PUBLIC_URL must not have a path/,
    )
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'ftp://example.com' })).toThrow(/PUBLIC_URL/)
  })

  it('needs MAIL_FROM with SMTP_URL and only accepts smtp(s) URLs', () => {
    const smtp = { ...base, SMTP_URL: 'smtps://resend:re_123@smtp.resend.com:465' }
    expect(() => loadConfig(smtp)).toThrow(/MAIL_FROM is required/)
    expect(loadConfig({ ...smtp, MAIL_FROM: 'Hourmere <hi@example.com>' }).SMTP_URL).toBe(
      smtp.SMTP_URL,
    )
    expect(() =>
      loadConfig({ ...base, SMTP_URL: 'https://smtp.example.com', MAIL_FROM: 'a@example.com' }),
    ).toThrow(/SMTP_URL must look like/)
  })

  describe('social sign-in', () => {
    it('enables a provider when both its client id and secret are set', () => {
      const c = loadConfig({
        ...base,
        GOOGLE_CLIENT_ID: 'g-id',
        GOOGLE_CLIENT_SECRET: 'g-secret',
        MICROSOFT_CLIENT_ID: 'm-id',
        MICROSOFT_CLIENT_SECRET: 'm-secret',
      })
      expect(c.socialProviders).toEqual({
        google: { clientId: 'g-id', clientSecret: 'g-secret' },
        microsoft: { clientId: 'm-id', clientSecret: 'm-secret' },
      })
    })

    it('rejects half a provider configuration', () => {
      expect(() => loadConfig({ ...base, GOOGLE_CLIENT_ID: 'g-id' })).toThrow(
        /set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/,
      )
      expect(() => loadConfig({ ...base, MICROSOFT_CLIENT_SECRET: 'm-secret' })).toThrow(
        /MICROSOFT_CLIENT_ID/,
      )
    })
  })
})
