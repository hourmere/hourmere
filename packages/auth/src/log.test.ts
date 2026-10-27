import { describe, expect, it, vi } from 'vitest'
import { betterAuthLog, escapeControlCharacters, logMailFailure, redactLogDetails } from './log.ts'

describe('Better Auth diagnostic privacy', () => {
  it('retains diagnostics with URL queries and UUIDs redacted at every level', () => {
    const invitationId = '00000000-0000-4000-8000-000000000071'
    const next = `/app/join?invitationId=${invitationId}`
    const callback = `https://evil.example/sign-in?${new URLSearchParams({ next })}`
    const calls: unknown[][] = []
    const spies = ['log', 'warn', 'error'].map((method) =>
      vi.spyOn(console, method as 'log' | 'warn' | 'error').mockImplementation((...args) => {
        calls.push(args)
      }),
    )
    try {
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        betterAuthLog(level, `Invalid callbackURL: ${callback}\nInvitation ${invitationId}`, {
          invitationId,
          error: new Error(`Invitation lookup failed: ${invitationId}`),
          callback: "https://evil.example/sign-in?value=left'private-query",
        })
      }
      expect(calls).toHaveLength(4)
      expect(
        calls.every((args) =>
          args.join(' ').includes('Invalid callbackURL: https://evil.example/sign-in'),
        ),
      ).toBe(true)
      expect(
        calls.every((args) => args.join(' ').includes('Invitation lookup failed: [redacted UUID]')),
      ).toBe(true)
      expect(calls.every((args) => args.join(' ').includes('\\nInvitation [redacted UUID]'))).toBe(
        true,
      )
      expect(JSON.stringify(calls).includes(invitationId)).toBe(false)
      expect(JSON.stringify(calls).includes('next=')).toBe(false)
      expect(JSON.stringify(calls).includes('private-query')).toBe(false)
      expect(calls.every((args) => !args.join(' ').includes('\n'))).toBe(true)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it('bounds the only retained dynamic API-key code', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      betterAuthLog('error', 'Failed to validate API key', { body: { code: '/app/join?private' } })
      expect(info.mock.calls).toEqual([['[auth] API key rejected: INVALID_API_KEY']])
    } finally {
      info.mockRestore()
    }
  })
})

describe('redactLogDetails', () => {
  it('removes query and fragment tails containing quotes or backslashes', () => {
    for (const delimiter of ["'", '"', '\\', '`', '<', '>']) {
      for (const separator of ['?', '#']) {
        expect(
          redactLogDetails(
            `Invalid callbackURL: https://evil.example/join${separator}left${delimiter}private-query then failed`,
          ),
        ).toBe('Invalid callbackURL: https://evil.example/join then failed')
      }
    }
  })

  it('strips query strings and fragments while keeping absolute and local URL paths', () => {
    expect(
      redactLogDetails(
        'Rejected https://evil.example/path?secret=value#private then /app/join?invitationId=private',
      ),
    ).toBe('Rejected https://evil.example/path then /app/join')
    expect(
      redactLogDetails(
        'Rejected https://evil.example/path#private then //evil.example/path?secret=value',
      ),
    ).toBe('Rejected https://evil.example/path then //evil.example/path')
    expect(redactLogDetails('Rejected custom://callback/path?secret=value#private')).toBe(
      'Rejected custom://callback/path',
    )
  })

  it('redacts invitation UUIDs in URL paths and plain messages, including uppercase', () => {
    const invitationId = '019A06AB-0000-7000-8000-000000000071'
    expect(
      redactLogDetails(
        `Invitation ${invitationId} failed at https://host.example/invitations/${invitationId}#private`,
      ),
    ).toBe('Invitation [redacted UUID] failed at https://host.example/invitations/[redacted UUID]')
  })
})

describe('escapeControlCharacters', () => {
  it('escapes line breaks, other control characters and bidi controls', () => {
    expect(escapeControlCharacters('a\nb\r\tc')).toBe('a\\nb\\r\\tc')
    expect(escapeControlCharacters('\u0000\u001b[31m\u007f\u0085')).toBe(
      '\\u0000\\u001b[31m\\u007f\\u0085',
    )
    expect(escapeControlCharacters('\u2028\u2029')).toBe('\\u2028\\u2029')
    // Embeddings and overrides (U+202A to U+202E), isolates (U+2066 to U+2069).
    expect(escapeControlCharacters('x\u202ay\u202ez\u2066w\u2069')).toBe(
      'x\\u202ay\\u202ez\\u2066w\\u2069',
    )
  })

  it('leaves ordinary text alone, including other non-ASCII', () => {
    expect(escapeControlCharacters('Zoë → 李雷 \\ "quoted"')).toBe('Zoë → 李雷 \\ "quoted"')
  })
})

describe('logMailFailure', () => {
  const logged = (err: unknown) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      logMailFailure(err)
      return error.mock.calls.map((args) => args.join(' '))
    } finally {
      error.mockRestore()
    }
  }

  it("logs the SMTP error's code, response code and command, never its message", () => {
    const err = Object.assign(new Error('550 <ada@example.com> rejected: https://x/#token=abc'), {
      code: 'EENVELOPE',
      responseCode: 550,
      command: 'RCPT TO',
    })
    expect(logged(err)).toEqual([
      '[auth] sign-in email not sent (code=EENVELOPE, responseCode=550, command=RCPT TO)',
    ])
    expect(logged(new Error('ada@example.com'))).toEqual(['[auth] sign-in email not sent'])
    expect(logged('ada@example.com')).toEqual(['[auth] sign-in email not sent'])
  })

  it('keeps odd values to one short line', () => {
    expect(logged({ code: `E\n[mail] {"forged":true}${'x'.repeat(100)}` })).toEqual([
      `[auth] sign-in email not sent (code=E\\n[mail] {"forged":true}${'x'.repeat(40)})`,
    ])
  })

  it('never throws, whatever the error looks like', () => {
    const throwingGetter = Object.defineProperty({}, 'code', {
      get: () => {
        throw new Error('no')
      },
    })
    const unprintable = {
      code: {
        toString: () => {
          throw new Error('no')
        },
      },
    }
    for (const err of [throwingGetter, unprintable, { message: 42 }, null, Symbol('x')]) {
      expect(() => logged(err)).not.toThrow()
    }
    expect(logged(throwingGetter)).toEqual(['[auth] sign-in email not sent (details unavailable)'])
    expect(logged(unprintable)).toEqual(['[auth] sign-in email not sent (details unavailable)'])
    // Even when logging itself fails.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('stderr closed')
    })
    try {
      expect(() => logMailFailure(new Error('x'))).not.toThrow()
    } finally {
      error.mockRestore()
    }
  })
})
