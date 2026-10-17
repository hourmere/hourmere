import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

const base = {
  DATABASE_URL: 'postgres://hourmere@localhost:5432/hourmere',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
}

describe('loadConfig', () => {
  it('keeps MCP OAuth opt-in and requires a secure canonical origin when enabled', () => {
    expect(loadConfig(base).MCP_OAUTH_ENABLED).toBe(false)
    expect(loadConfig({ ...base, MCP_OAUTH_ENABLED: '' }).MCP_OAUTH_ENABLED).toBe(false)
    for (const PUBLIC_URL of [
      'https://hourmere.example.com',
      'http://localhost:4197',
      'http://127.0.0.1:4197',
      'http://[::1]:4197',
    ])
      expect(loadConfig({ ...base, MCP_OAUTH_ENABLED: 'true', PUBLIC_URL }).MCP_OAUTH_ENABLED).toBe(
        true,
      )
    expect(() =>
      loadConfig({ ...base, MCP_OAUTH_ENABLED: 'true', PUBLIC_URL: 'http://192.168.1.1' }),
    ).toThrow(/MCP OAuth requires HTTPS/)
    expect(loadConfig({ ...base, PUBLIC_URL: 'http://192.168.1.1' }).MCP_OAUTH_ENABLED).toBe(false)
    expect(() => loadConfig({ ...base, MCP_OAUTH_ENABLED: 'yes' })).toThrow(/MCP_OAUTH_ENABLED/)
  })
  it.each(['GOOGLE', 'MICROSOFT'] as const)(
    'configures %s calendar OAuth independently of sign-in and requires encryption',
    (provider) => {
      const name = provider === 'GOOGLE' ? 'Google' : 'Microsoft'
      const calendar = {
        [`${provider}_CALENDAR_CLIENT_ID`]: 'calendar-client',
        [`${provider}_CALENDAR_CLIENT_SECRET`]: 'calendar-secret',
        CALENDAR_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64'),
      }
      expect(loadConfig({ ...base, ...calendar }).socialProviders).toEqual({})
      for (const missing of Object.keys(calendar)) {
        expect(() => loadConfig({ ...base, ...calendar, [missing]: '' })).toThrow(
          new RegExp(`${name} Calendar requires`),
        )
      }
      expect(() =>
        loadConfig({ ...base, ...calendar, PUBLIC_URL: 'http://app.example.com' }),
      ).toThrow(/requires HTTPS/)
      expect(() =>
        loadConfig({ ...base, ...calendar, CALENDAR_ENCRYPTION_KEY: 'private-invalid-value' }),
      ).toThrow(/32 random bytes/)
      expect(() =>
        loadConfig({ ...base, ...calendar, CALENDAR_ENCRYPTION_KEY: 'private-invalid-value' }),
      ).not.toThrow(/private-invalid-value/)
      expect(
        loadConfig({
          ...base,
          [`${provider}_CALENDAR_CLIENT_ID`]: '',
          [`${provider}_CALENDAR_CLIENT_SECRET`]: '',
          CALENDAR_ENCRYPTION_KEY: '',
        })[`${provider}_CALENDAR_CLIENT_ID`],
      ).toBeUndefined()
    },
  )
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

  it('takes the HSTS max-age in seconds, a year unless set', () => {
    expect(loadConfig(base).HSTS_MAX_AGE).toBe(31_536_000)
    expect(loadConfig({ ...base, HSTS_MAX_AGE: '' }).HSTS_MAX_AGE).toBe(31_536_000)
    expect(loadConfig({ ...base, HSTS_MAX_AGE: '15768000' }).HSTS_MAX_AGE).toBe(15_768_000)
    expect(loadConfig({ ...base, HSTS_MAX_AGE: '0' }).HSTS_MAX_AGE).toBe(0)
    for (const bad of ['-1', '1.5', '1y', 'off']) {
      expect(() => loadConfig({ ...base, HSTS_MAX_AGE: bad }), bad).toThrow(
        /HSTS_MAX_AGE must be a whole number of seconds/,
      )
    }
  })

  it('takes HTTP timeouts in whole seconds and passes them on in milliseconds', () => {
    const defaults = { headers: 20_000, request: 60_000, keepAlive: 125_000 }
    expect(loadConfig(base).httpTimeouts).toEqual(defaults)
    expect(
      loadConfig({
        ...base,
        HTTP_HEADERS_TIMEOUT: '',
        HTTP_REQUEST_TIMEOUT: '',
        HTTP_KEEP_ALIVE_TIMEOUT: '',
      }).httpTimeouts,
    ).toEqual(defaults)
    expect(
      loadConfig({
        ...base,
        HTTP_HEADERS_TIMEOUT: '10',
        HTTP_REQUEST_TIMEOUT: '120',
        HTTP_KEEP_ALIVE_TIMEOUT: '180',
      }).httpTimeouts,
    ).toEqual({ headers: 10_000, request: 120_000, keepAlive: 180_000 })
    // Keep-alive is independent of the other two: idling is not part of a request.
    expect(
      loadConfig({ ...base, HTTP_HEADERS_TIMEOUT: '5', HTTP_REQUEST_TIMEOUT: '5' }).httpTimeouts
        .keepAlive,
    ).toBe(125_000)
    // Milliseconds by mistake, fractions, zero (which would turn Node's timeout off).
    for (const bad of ['60000', '0.5', '0', '-5', '1m']) {
      expect(() => loadConfig({ ...base, HTTP_REQUEST_TIMEOUT: bad }), bad).toThrow(
        /HTTP_REQUEST_TIMEOUT must be a whole number of seconds from 1 to 3600/,
      )
    }
    expect(() => loadConfig({ ...base, HTTP_KEEP_ALIVE_TIMEOUT: '0' })).toThrow(
      /HTTP_KEEP_ALIVE_TIMEOUT must be a whole number of seconds/,
    )
    // Node refuses a headers timeout longer than the request timeout.
    expect(() =>
      loadConfig({ ...base, HTTP_HEADERS_TIMEOUT: '30', HTTP_REQUEST_TIMEOUT: '20' }),
    ).toThrow(/HTTP_HEADERS_TIMEOUT must not be longer than HTTP_REQUEST_TIMEOUT/)
    expect(
      loadConfig({ ...base, HTTP_HEADERS_TIMEOUT: '20', HTTP_REQUEST_TIMEOUT: '20' }).httpTimeouts
        .request,
    ).toBe(20_000)
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
