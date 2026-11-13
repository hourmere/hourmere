import { describe, expect, it } from 'vitest'
import {
  MAX_SSO_PRIVATE_TARGETS,
  parseSsoPrivateTargets,
  ssoPrivateTargetFor,
} from './sso-private-targets.ts'

describe('SSO_PRIVATE_TARGETS setting', () => {
  it('defaults to an immutable empty allowlist', () => {
    for (const value of [undefined, '', '   ']) expect(parseSsoPrivateTargets(value)).toEqual([])
    expect(Object.isFrozen(parseSsoPrivateTargets())).toBe(true)
  })

  it.each([
    ['keycloak:8443', { host: 'keycloak', port: 8443 }],
    ['Keycloak.Internal:443', { host: 'keycloak.internal', port: 443 }],
    ['idp.corp.example.com:8443', { host: 'idp.corp.example.com', port: 8443 }],
    ['localhost:8080', { host: 'localhost', port: 8080 }],
    ['10.0.0.5:9443', { host: '10.0.0.5', port: 9443 }],
    ['172.16.0.1:443', { host: '172.16.0.1', port: 443 }],
    ['192.168.1.20:65535', { host: '192.168.1.20', port: 65535 }],
    ['127.0.0.1:1', { host: '127.0.0.1', port: 1 }],
    ['[::1]:8443', { host: '::1', port: 8443 }],
    ['[FD12:0:0::5]:443', { host: 'fd12::5', port: 443 }],
  ])('accepts the exact entry %s', (value, expected) => {
    const targets = parseSsoPrivateTargets(value)
    expect(targets).toEqual([expected])
    expect(Object.isFrozen(targets)).toBe(true)
    expect(Object.isFrozen(targets[0])).toBe(true)
  })

  it('trims entry separators and keeps the order', () => {
    expect(parseSsoPrivateTargets(' idp.internal:8443 , [fd12::5]:443 ')).toEqual([
      { host: 'idp.internal', port: 8443 },
      { host: 'fd12::5', port: 443 },
    ])
  })

  it.each([
    ',',
    'idp.internal:8443,',
    'idp.internal',
    'idp.internal:',
    'idp.internal:0',
    'idp.internal:65536',
    'idp.internal:08443',
    'idp.internal:8443-8444',
    'idp.internal:*',
    '*.internal:443',
    'idp.internal.:443',
    '-idp.internal:443',
    'idp_internal:443',
    'idp internal:443',
    'https://idp.internal:443',
    'idp.internal:443/path',
    'user@idp.internal:443',
    'bücher.internal:443',
    `${'a'.repeat(64)}.internal:443`,
    `${'a.'.repeat(127)}a:443`,
    '127.1:443',
    '010.0.0.1:443',
    '0x7f000001:443',
    '10.0.0.0/8:443',
    '[fd12::/64]:443',
    '::1:443',
    '[10.0.0.1]:443',
    '[::1]',
    '8.8.8.8:443',
    '[2606:4700:4700::1111]:443',
    '169.254.169.254:80',
    '100.100.100.200:80',
    '100.64.0.1:443',
    '0.0.0.0:443',
    '[fe80::1]:443',
    '[fe80::1%eth0]:443',
    '[fd00:ec2::254]:80',
    '[fd20:ce::254]:80',
    '[::ffff:10.0.0.1]:443',
    '[::ffff:a00:1]:443',
    '[::]:443',
  ])('refuses %s without echoing it', (value) => {
    expect(() => parseSsoPrivateTargets(value)).toThrow(/^Invalid SSO_PRIVATE_TARGETS setting$/)
  })

  it('caps the number of entries', () => {
    const entries = (n: number) =>
      Array.from({ length: n }, (_, i) => `idp${i}.internal:443`).join(',')
    expect(parseSsoPrivateTargets(entries(MAX_SSO_PRIVATE_TARGETS))).toHaveLength(
      MAX_SSO_PRIVATE_TARGETS,
    )
    expect(() => parseSsoPrivateTargets(entries(MAX_SSO_PRIVATE_TARGETS + 1))).toThrow(
      'Invalid SSO_PRIVATE_TARGETS setting',
    )
  })
})

describe('exact SSO private target matching', () => {
  const targets = parseSsoPrivateTargets('idp.internal:8443,10.0.0.5:9443')
  it('matches exactly the listed host and port', () => {
    expect(ssoPrivateTargetFor('idp.internal', 8443, targets)).toEqual({
      host: 'idp.internal',
      port: 8443,
    })
    expect(ssoPrivateTargetFor('10.0.0.5', 9443, targets)).toEqual({ host: '10.0.0.5', port: 9443 })
  })
  it.each([
    ['idp.internal', 8444],
    ['idp.internal', 443],
    ['IDP.internal', 8443],
    ['other.internal', 8443],
    ['idp.internal.evil', 8443],
    ['10.0.0.5', 8443],
    ['10.0.0.6', 9443],
    ['idp.internal', 9443],
  ])('does not match %s:%i', (host, port) => {
    expect(ssoPrivateTargetFor(host, port, targets)).toBeUndefined()
  })
  it('matches nothing when the setting is empty', () => {
    expect(ssoPrivateTargetFor('idp.internal', 8443, parseSsoPrivateTargets())).toBeUndefined()
  })
})
