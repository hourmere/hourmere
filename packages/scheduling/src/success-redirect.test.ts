import { describe, expect, it } from 'vitest'
import { bookingSuccessRedirect, validateSuccessRedirect } from './success-redirect.ts'

describe('success redirect validation', () => {
  it.each([
    'http://example.com',
    'javascript:alert(1)',
    'data:text/html,example',
    '//example.com',
    '/relative',
    'https:example.com',
    'https:///example.com',
    'https://',
    'https://user@example.com',
    'https://user:password@example.com',
    'https://us%40er:pass%3Aword@example.com',
    'https://@example.com',
    'https://:@example.com',
    'https://:password@example.com',
    'https://example.com\\@other.example',
    'https://example.com/path\\segment',
    'https://example.com/?query=back\\slash',
    'https://example.com/#back\\slash',
    'https://exa\tmple.com',
    'https://example.com/\npath',
    ' https://example.com',
    'https://example.com/path with spaces',
    '\nhttps://example.com',
    'https://example.com/\u0085',
    'https://example.com/\u2028',
    'https://example.com/\ud800',
    'https://bad_host.example',
    'https://-bad.example',
    'https://example..com',
    `https://${'a'.repeat(64)}.example`,
    `https://example.com/${'x'.repeat(2000)}`,
    `https://example.com/${'東'.repeat(300)}`,
  ])('rejects unsafe target %j', (url) => {
    expect(() => validateSuccessRedirect({ url })).toThrowError(
      expect.objectContaining({ code: 'invalid_success_redirect' }),
    )
  })
  it.each([
    'https://127.0.0.1',
    'https://127.1',
    'https://2130706433',
    'https://0x7f000001',
    'https://0177.0.0.1',
    'https://127.0.0.1.',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
  ])('rejects parsed IP host %s unless explicitly allowed', (url) => {
    expect(() => validateSuccessRedirect({ url })).toThrowError(/IP host/)
    expect(validateSuccessRedirect({ url }, { allowIpHosts: true })?.url).toBe(new URL(url).href)
    expect(validateSuccessRedirect({ url }, { publicUrl: new URL(url).origin })?.url).toBe(
      new URL(url).href,
    )
    expect(() =>
      validateSuccessRedirect({ url }, { publicUrl: 'https://example.com' }),
    ).toThrowError(/IP host/)
  })
  it.each([
    'https://localhost',
    'https://LOCALHOST.',
    'https://a.localhost',
    'https://a.b.localhost.',
    'https://intranet',
    'https://INTRANET.',
  ])('rejects local host %s unless explicitly allowed or the instance own host', (url) => {
    expect(() => validateSuccessRedirect({ url })).toThrowError(/localhost or a single-label/)
    expect(validateSuccessRedirect({ url }, { allowIpHosts: true })?.url).toBe(new URL(url).href)
    expect(validateSuccessRedirect({ url }, { publicUrl: new URL(url).origin })?.url).toBe(
      new URL(url).href,
    )
    expect(() =>
      validateSuccessRedirect({ url }, { publicUrl: 'https://example.com' }),
    ).toThrowError(/localhost or a single-label/)
  })
  it('limits the own-host exception to the exact hostname', () => {
    expect(() =>
      validateSuccessRedirect(
        { url: 'https://other.localhost' },
        { publicUrl: 'https://app.localhost' },
      ),
    ).toThrowError(/localhost/)
    expect(validateSuccessRedirect({ url: 'https://localhost.example.com' })?.url).toBe(
      'https://localhost.example.com/',
    )
  })
  it('normalizes IDN, Unicode path, casing and default ports with private defaults', () => {
    expect(validateSuccessRedirect({ url: 'HTTPS://例え.テスト:443/完了?x=1#done' })).toEqual({
      url: 'https://xn--r8jz45g.xn--zckzah/%E5%AE%8C%E4%BA%86?x=1#done',
      parameters: [],
      includeInviteePersonalData: false,
      allowEmbedParent: false,
    })
    expect(
      validateSuccessRedirect({ url: `https://example.com/${'x'.repeat(1980)}` })?.url.length,
    ).toBe(2000)
    expect(validateSuccessRedirect(null)).toBeNull()
  })
  it.each([
    ['bookingId'],
    ['id'],
    ['uid'],
    ['manageToken'],
    ['rescheduleToken'],
    ['phone'],
    ['responses'],
    ['guestEmails'],
    ['inviteeEmail', 'inviteeEmail'],
    ['start', 'start'],
  ])('rejects non-whitelisted or duplicate parameters %j', (...parameters) => {
    expect(() =>
      validateSuccessRedirect({
        url: 'https://example.com',
        parameters,
        includeInviteePersonalData: true,
      }),
    ).toThrowError(/parameters/)
  })
  it.each(['inviteeName', 'inviteeEmail'])(
    'requires explicit informed opt-in for %s',
    (parameter) => {
      for (const optIn of [undefined, false])
        expect(() =>
          validateSuccessRedirect({
            url: 'https://example.com',
            parameters: [parameter],
            includeInviteePersonalData: optIn,
          }),
        ).toThrowError(/visible to the target website and its analytics/)
      expect(
        validateSuccessRedirect({
          url: 'https://example.com',
          parameters: [parameter],
          includeInviteePersonalData: true,
        })?.parameters,
      ).toEqual([parameter])
    },
  )
  it.each([
    { input: [] },
    { input: 'https://example.com' },
    { input: undefined },
    { input: { url: 'https://example.com', allowEmbedParent: 'true' } },
    { input: { url: 'https://example.com', includeInviteePersonalData: 1 } },
    { input: { url: 'https://example.com', parameters: 'start' } },
    { input: { url: 'https://example.com', typo: true } },
  ])('rejects malformed settings $input', ({ input }) => {
    expect(() => validateSuccessRedirect(input)).toThrowError()
  })
  it('encodes exactly the whitelist and preserves existing query parameters and fragment', () => {
    const settings = validateSuccessRedirect({
      url: 'https://example.com/done?campaign=a%2Bb&start=old#thanks',
      parameters: [
        'eventTypeSlug',
        'start',
        'end',
        'timeZone',
        'hostName',
        'inviteeName',
        'inviteeEmail',
      ],
      includeInviteePersonalData: true,
      allowEmbedParent: true,
    })
    const snapshot = bookingSuccessRedirect(settings, {
      eventTypeSlug: 'a-call',
      start: '2026-11-02T09:00:00.000Z',
      end: '2026-11-02T09:30:00.000Z',
      timeZone: 'America/Los_Angeles',
      hostName: 'Host & 東京',
      inviteeName: 'A & B=✓',
      inviteeEmail: 'a+b@example.com',
    })
    const url = new URL(snapshot?.url as string)
    expect([...url.searchParams.keys()]).toEqual([
      'campaign',
      'start',
      'eventTypeSlug',
      'start',
      'end',
      'timeZone',
      'hostName',
      'inviteeName',
      'inviteeEmail',
    ])
    expect(url.searchParams.get('campaign')).toBe('a+b')
    expect(url.searchParams.get('inviteeName')).toBe('A & B=✓')
    expect(url.searchParams.get('inviteeEmail')).toBe('a+b@example.com')
    expect(url.searchParams.getAll('start')).toEqual(['old', '2026-11-02T09:00:00.000Z'])
    expect(url.hash).toBe('#thanks')
    expect(snapshot?.allowEmbedParent).toBe(true)
  })
  it.each([
    ['https://example.com/p?x=%zz&flag&a;b#done', '&', '#done'],
    ['https://example.com/p?x=%zz&flag&a;b', '&', ''],
    ['https://example.com/p?#done', '&', '#done'],
    ['https://example.com/p#done', '?', '#done'],
    ['https://example.com/p#', '?', '#'],
  ])('preserves the query verbatim when appending to %s', (target, separator, fragment) => {
    const settings = validateSuccessRedirect({
      url: target,
      parameters: ['hostName', 'inviteeEmail'],
      includeInviteePersonalData: true,
    })
    const values = {
      eventTypeSlug: 'call',
      start: 'start',
      end: 'end',
      timeZone: 'UTC',
      hostName: 'A & B=東京',
      inviteeName: 'Invitee',
      inviteeEmail: 'a+b@example.com',
    }
    expect(bookingSuccessRedirect(settings, values)?.url).toBe(
      `${target.slice(0, target.length - fragment.length)}${separator}hostName=A+%26+B%3D%E6%9D%B1%E4%BA%AC&inviteeEmail=a%2Bb%40example.com${fragment}`,
    )
    expect(bookingSuccessRedirect(validateSuccessRedirect({ url: target }), values)?.url).toBe(
      target,
    )
  })
})
