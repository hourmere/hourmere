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

  it('rejects a BETTER_AUTH_SECRET with fewer than 32 non-whitespace characters', () => {
    for (const secret of ['a'.repeat(31), `${' '.repeat(40)}short`, `${'ab \t'.repeat(15)}`]) {
      expect(() => loadConfig({ ...base, BETTER_AUTH_SECRET: secret }), secret).toThrow(
        /BETTER_AUTH_SECRET must have at least 32 non-whitespace characters/,
      )
    }
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
    for (const bad of [
      'https://smtp.example.com',
      'smtp:',
      'smtp://',
      'smtp:smtp.example.com',
      'smtps://u:p@smtp.example.com/inbox',
      'smtps://u:p@smtp.example.com#frag',
    ]) {
      expect(() => loadConfig({ ...base, SMTP_URL: bad, MAIL_FROM: 'a@example.com' }), bad).toThrow(
        /SMTP_URL must look like/,
      )
    }
    expect(
      loadConfig({ ...base, SMTP_URL: 'smtp://relay:25/?pool=true', MAIL_FROM: 'a@example.com' })
        .SMTP_URL,
    ).toBe('smtp://relay:25/?pool=true')
  })

  it('parses TRUSTED_PROXIES and rejects entries that are not IPs or CIDR ranges', () => {
    expect(loadConfig(base).trustedProxies).toEqual([])
    expect(
      loadConfig({ ...base, TRUSTED_PROXIES: ' 172.16.0.0/12, 10.0.0.5 ,' }).trustedProxies,
    ).toEqual(['172.16.0.0/12', '10.0.0.5'])
    expect(() => loadConfig({ ...base, TRUSTED_PROXIES: 'proxy.internal' })).toThrow(
      /TRUSTED_PROXIES must be comma-separated IP addresses or CIDR ranges/,
    )
  })

  it('runs everything in one process unless HOURMERE_ROLE says otherwise', () => {
    expect(loadConfig(base).HOURMERE_ROLE).toBe('all')
    expect(loadConfig({ ...base, HOURMERE_ROLE: '' }).HOURMERE_ROLE).toBe('all')
    expect(loadConfig({ ...base, HOURMERE_ROLE: 'web' }).HOURMERE_ROLE).toBe('web')
    expect(loadConfig({ ...base, HOURMERE_ROLE: 'worker' }).HOURMERE_ROLE).toBe('worker')
    for (const bad of ['Worker', 'api', 'web,worker']) {
      expect(() => loadConfig({ ...base, HOURMERE_ROLE: bad }), bad).toThrow(
        /HOURMERE_ROLE must be all, web or worker/,
      )
    }
  })

  describe('sign-up', () => {
    it('defaults to first-user, also when compose passes the variables empty', () => {
      const policy = { mode: 'first-user', allowedDomains: [] }
      expect(loadConfig(base).signup).toEqual(policy)
      expect(loadConfig({ ...base, SIGNUP: '', SIGNUP_ALLOWED_DOMAINS: '' }).signup).toEqual(policy)
    })

    it('accepts each mode and normalizes the domain list', () => {
      expect(loadConfig({ ...base, SIGNUP: 'open' }).signup).toEqual({
        mode: 'open',
        allowedDomains: [],
      })
      expect(
        loadConfig({
          ...base,
          SIGNUP: 'closed',
          SIGNUP_ALLOWED_DOMAINS: ' Example.COM, team.example.org ,',
        }).signup,
      ).toEqual({ mode: 'closed', allowedDomains: ['example.com', 'team.example.org'] })
      expect(
        loadConfig({ ...base, SIGNUP: 'first-user', SIGNUP_ALLOWED_DOMAINS: 'xn--bcher-kva.de' })
          .signup.allowedDomains,
      ).toEqual(['xn--bcher-kva.de'])
    })

    it('rejects an unknown mode', () => {
      for (const mode of ['Open', 'invite', 'first_user', 'none']) {
        expect(() => loadConfig({ ...base, SIGNUP: mode }), mode).toThrow(
          /SIGNUP must be open, first-user or closed/,
        )
      }
    })

    it('rejects anything but plain email domains', () => {
      for (const domains of [
        '@example.com',
        '*.example.com',
        'user@example.com',
        'example',
        'example.com/x',
        'exa mple.com',
        'example.com;evil.com',
        'bücher.de',
        '-c search_path=public',
      ]) {
        expect(
          () => loadConfig({ ...base, SIGNUP: 'closed', SIGNUP_ALLOWED_DOMAINS: domains }),
          domains,
        ).toThrow(/SIGNUP_ALLOWED_DOMAINS must be comma-separated email domains/)
      }
    })

    it('rejects allowed domains with SIGNUP=open, where they would not restrict anything', () => {
      expect(() =>
        loadConfig({ ...base, SIGNUP: 'open', SIGNUP_ALLOWED_DOMAINS: 'example.com' }),
      ).toThrow(/SIGNUP_ALLOWED_DOMAINS has no effect with SIGNUP=open/)
    })
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
