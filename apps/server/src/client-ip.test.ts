import { CLIENT_IP_HEADER } from '@hourmere/auth'
import { describe, expect, it } from 'vitest'
import { createClientIpResolver, isTrustedProxyEntry, withClientIpHeader } from './client-ip.ts'

describe('createClientIpResolver', () => {
  const direct = createClientIpResolver([])
  const proxied = createClientIpResolver(['10.0.0.0/8', '192.0.2.1', 'fd00::/8'])

  it('uses the TCP peer when no proxy is trusted', () => {
    expect(direct('203.0.113.7', '6.6.6.6')).toBe('203.0.113.7')
    expect(direct('::ffff:203.0.113.7', undefined)).toBe('203.0.113.7')
    expect(direct(undefined, '6.6.6.6')).toBeUndefined()
  })

  it('ignores X-Forwarded-For from a peer that is not a trusted proxy', () => {
    expect(proxied('203.0.113.7', '6.6.6.6')).toBe('203.0.113.7')
  })

  it('takes the right-most untrusted address behind trusted proxies', () => {
    expect(proxied('192.0.2.1', '198.51.100.9')).toBe('198.51.100.9')
    expect(proxied('10.0.0.2', '6.6.6.6, 198.51.100.9, 10.4.4.4')).toBe('198.51.100.9')
    expect(proxied('fd00::1', '2001:db8::5')).toBe('2001:db8::5')
    expect(proxied('::ffff:10.0.0.2', ' 198.51.100.9 ')).toBe('198.51.100.9')
  })

  it('stops at a malformed entry and keeps the last good hop', () => {
    expect(proxied('10.0.0.2', '198.51.100.9, not-an-ip')).toBe('10.0.0.2')
    expect(proxied('10.0.0.2', '198.51.100.9, not-an-ip, 10.0.0.3')).toBe('10.0.0.3')
  })

  it('uses the left-most address when every hop is a trusted proxy', () => {
    expect(proxied('10.0.0.2', '10.0.0.9, 10.0.0.3')).toBe('10.0.0.9')
    expect(proxied('10.0.0.2', undefined)).toBe('10.0.0.2')
  })
})

describe('isTrustedProxyEntry', () => {
  it('accepts IP addresses and CIDR ranges only', () => {
    for (const ok of ['10.0.0.5', '172.16.0.0/12', '0.0.0.0/0', '::1', 'fd00::/8']) {
      expect(isTrustedProxyEntry(ok), ok).toBe(true)
    }
    for (const bad of ['proxy', '10.0.0.0/33', '::/129', '10.0.0.0/8/1', '10.0.0.0/x', '']) {
      expect(isTrustedProxyEntry(bad), bad).toBe(false)
    }
  })
})

describe('withClientIpHeader', () => {
  it('replaces whatever the client sent in the internal header', () => {
    const sent = new Headers({ [CLIENT_IP_HEADER]: '7.7.7.7', accept: 'application/json' })
    expect(withClientIpHeader(sent, '203.0.113.7').get(CLIENT_IP_HEADER)).toBe('203.0.113.7')
    const none = withClientIpHeader(sent, undefined)
    expect(none.has(CLIENT_IP_HEADER)).toBe(false)
    expect(none.get('accept')).toBe('application/json')
  })
})
