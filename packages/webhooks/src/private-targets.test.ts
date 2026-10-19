import { describe, expect, it } from 'vitest'
import {
  isWebhookPrivateAddress,
  parseWebhookPrivateTargets,
  privateTargetCandidates,
  privateTargetContains,
} from './private-targets.ts'

describe('operator private webhook target setting', () => {
  it('defaults to an immutable empty allowlist', () => {
    expect(parseWebhookPrivateTargets()).toEqual([])
    expect(parseWebhookPrivateTargets('  ')).toEqual([])
    expect(Object.isFrozen(parseWebhookPrivateTargets())).toBe(true)
  })
  it.each([
    'n8n:5678',
    'home-assistant.local:8123',
    'localhost:80',
    '10.0.0.5:5678',
    '10.0.0.0/8:1-65535',
    '172.16.0.0/12:8080',
    '192.168.1.0/24:8080-8081',
    '127.0.0.1:80',
    '[::1]:443',
    '[fc00::/8]:80',
    '[fd12:3456::/64]:8443',
    '[fd00:ec3::]:80',
    '[fd20:ce::253]:80',
    '[fd20:ce::255]:80',
    '[fd00:c1::a9fe:a9fd]:80',
    '[fd00:c1::a9fe:a9ff]:80',
  ])('accepts the explicit private entry %s', (value) => {
    const targets = parseWebhookPrivateTargets(value)
    expect(targets).toHaveLength(1)
    expect(Object.isFrozen(targets)).toBe(true)
    expect(Object.isFrozen(targets[0])).toBe(true)
  })
  it('normalizes DNS case and trims only entry separators', () => {
    expect(parseWebhookPrivateTargets(' N8N:5678 , 192.168.0.0/16:8080 ')).toEqual([
      { kind: 'host', host: 'n8n', portStart: 5678, portEnd: 5678 },
      {
        kind: 'network',
        network: '192.168.0.0',
        prefix: 16,
        family: 4,
        portStart: 8080,
        portEnd: 8080,
      },
    ])
  })
  it.each([
    ',',
    'n8n:5678,',
    'n8n',
    'n8n:0',
    'n8n:65536',
    'n8n:080',
    'n8n:1-2',
    'n8n:5678-5678',
    'n8n:*',
    '*.internal:80',
    'n8n.:80',
    '-n8n:80',
    'n8n_:80',
    'n8n: 80',
    'n8n\n:80',
    'user@n8n:80',
    'http://n8n:80',
    'n8n/path:80',
    'n8n/24:80',
    '0x7f000001:80',
    '0x7f.0.0.1:80',
    'n8n.123:80',
    '127.1:80',
    '2130706433:80',
    '8.8.8.8:80',
    '0.0.0.0/0:80',
    '10.0.0.0/7:80',
    '10.0.0.1/24:80',
    '10.0.0.0/33:80',
    '10.0.0.0/08:80',
    '10.0.0.0/24/24:80',
    '10.0.0.1:100-99',
    '10.0.0.1:80-65536',
    '10.0.0.1:80-080',
    '169.254.169.254:80',
    '169.254.0.0/16:80',
    '100.100.100.200:80',
    '100.64.0.0/10:80',
    '192.0.0.1:80',
    '198.18.0.1:80',
    '224.0.0.1:80',
    '[10.0.0.1]:80',
    'fd12::1:80',
    '[::/0]:80',
    '[::]:80',
    '[fe80::1]:80',
    '[::ffff:127.0.0.1]:80',
    '[2001:4860:4860::8888]:80',
    '[fd00:ec2::254]:80',
    '[fd00:ec2::/64]:80',
    '[fd00::/8]:80',
    '[fc00::/7]:80',
    '[fd12::1/64]:80',
    '[fd12::/129]:80',
    '[fd12::/064]:80',
    '[fd12::1%lo0]:80',
    `${'a'.repeat(64)}:80`,
    `${Array(5).fill('a'.repeat(60)).join('.')}:80`,
  ])('rejects invalid, public, metadata or excessive entry %s without echoing it', (value) => {
    expect(() => parseWebhookPrivateTargets(value)).toThrow(
      /^Invalid WEBHOOK_PRIVATE_TARGETS setting$/,
    )
  })
  it('caps the setting at 32 entries', () => {
    expect(parseWebhookPrivateTargets(Array(32).fill('n8n:5678').join(','))).toHaveLength(32)
    expect(() => parseWebhookPrivateTargets(Array(33).fill('n8n:5678').join(','))).toThrow(
      'Invalid',
    )
  })
  it.each([
    ['10.0.0.0', true],
    ['10.255.255.255', true],
    ['9.255.255.255', false],
    ['11.0.0.0', false],
    ['172.15.255.255', false],
    ['172.16.0.0', true],
    ['172.31.255.255', true],
    ['172.32.0.0', false],
    ['192.167.255.255', false],
    ['192.168.0.0', true],
    ['192.168.255.255', true],
    ['192.169.0.0', false],
    ['126.255.255.255', false],
    ['127.0.0.0', true],
    ['127.255.255.255', true],
    ['128.0.0.0', false],
    ['::1', true],
    ['::2', false],
    ['fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', false],
    ['fc00::', true],
    ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', true],
    ['fe00::', false],
    ['fd00:ec1:ffff:ffff:ffff:ffff:ffff:ffff', true],
    ['fd00:ec2::', false],
    ['fd00:ec2::253', false],
    ['fd00:ec2::254', false],
    ['fd00:ec2::255', false],
    ['fd00:ec2:ffff:ffff:ffff:ffff:ffff:ffff', false],
    ['fd00:ec3::', true],
    ['fd20:ce::253', true],
    ['fd20:ce::254', false],
    ['fd20:ce::255', true],
    ['fd00:c1::a9fe:a9fd', true],
    ['fd00:c1::a9fe:a9fe', false],
    ['fd00:c1::a9fe:a9ff', true],
    ['169.254.169.254', false],
    ['100.100.100.200', false],
    ['::ffff:10.0.0.1', false],
    ['not-an-address', false],
  ])('classifies private/loopback address %s as %s', (value, expected) => {
    expect(isWebhookPrivateAddress(value)).toBe(expected)
  })
  it('checks both CIDR boundaries and the whole explicit port range', () => {
    const targets = parseWebhookPrivateTargets('192.168.1.0/24:8080-8082,[fd12::/64]:8443')
    for (const port of [8079, 8080, 8081, 8082, 8083]) {
      expect(privateTargetCandidates('192.168.1.0', port, targets)).toHaveLength(
        port >= 8080 && port <= 8082 ? 1 : 0,
      )
    }
    const network = targets[0]
    if (!network) throw new Error('Missing target')
    expect(privateTargetContains(network, '192.168.0.255')).toBe(false)
    expect(privateTargetContains(network, '192.168.1.0')).toBe(true)
    expect(privateTargetContains(network, '192.168.1.255')).toBe(true)
    expect(privateTargetContains(network, '192.168.2.0')).toBe(false)
    expect(privateTargetContains(network, 'fd12::1')).toBe(false)
    const ipv6 = targets[1]
    if (!ipv6) throw new Error('Missing IPv6 target')
    expect(privateTargetContains(ipv6, 'fd11:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(false)
    expect(privateTargetContains(ipv6, 'fd12::')).toBe(true)
    expect(privateTargetContains(ipv6, 'fd12::ffff:ffff:ffff:ffff')).toBe(true)
    expect(privateTargetContains(ipv6, 'fd12:0:0:1::')).toBe(false)
  })
})

describe('cloud metadata exclusions', () => {
  it.each([
    '169.254.169.254:80',
    '169.254.0.0/16:80',
    '169.254.168.0/22:80',
    '100.100.100.200:80',
    '100.100.100.200/31:80',
    '100.64.0.0/10:80',
    '[fd00:ec2::254]:80',
    '[fd00:ec2::254/127]:80',
    '[fd00:ec2::/64]:80',
    '[fd00:ec2::/32]:80',
    '[fd00:ec2::/31]:80',
    '[fd00:ec2::255]:80',
    '[fd00:ec2:ffff:ffff:ffff:ffff:ffff:ffff]:80',
    '[fd20:ce::254]:80',
    '[fd20:ce::254/127]:80',
    '[fd20:ce::/64]:80',
    '[fd20::/20]:80',
    '[fd00:c1::a9fe:a9fe]:80',
    '[fd00:00c1:0:0:0:0:a9fe:a9fe]:80',
    '[fd00:c1::a9fe:a9fe/127]:80',
    '[fd00:c1::/64]:80',
    '[fd00:c1::/32]:80',
    '[fd00::/24]:80',
    '[fd00::/8]:80',
    '[fc00::/7]:80',
  ])('refuses metadata endpoint or intersecting range %s at startup', (entry) => {
    expect(() => parseWebhookPrivateTargets(entry)).toThrow(
      /^Invalid WEBHOOK_PRIVATE_TARGETS setting$/,
    )
  })

  it.each(
    ['169.254.169.254', '100.100.100.200'].flatMap((address) => {
      const words = address.split('.').map(Number)
      const hex = `${((words[0] ?? 0) * 256 + (words[1] ?? 0)).toString(16)}:${((words[2] ?? 0) * 256 + (words[3] ?? 0)).toString(16)}`
      return [
        `::ffff:${address}`,
        `::ffff:${hex}`,
        `64:ff9b::${address}`,
        `64:ff9b::${hex}`,
        `64:ff9b:1::${address}`,
        `64:ff9b:1::${hex}`,
      ]
    }),
  )('refuses IPv4-mapped/NAT64 metadata address %s', (address) => {
    expect(() => parseWebhookPrivateTargets(`[${address}]:80`)).toThrow(
      /^Invalid WEBHOOK_PRIVATE_TARGETS setting$/,
    )
    expect(() => parseWebhookPrivateTargets(`[${address}/128]:80`)).toThrow(
      /^Invalid WEBHOOK_PRIVATE_TARGETS setting$/,
    )
    expect(isWebhookPrivateAddress(address)).toBe(false)
    const host = parseWebhookPrivateTargets('receiver:80')[0]
    if (!host) throw new Error('Missing target')
    expect(privateTargetContains(host, address)).toBe(false)
  })
})
