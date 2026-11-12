import { BlockList, isIP } from 'node:net'

// Conservative special-purpose policy, including globally reachable anycast entries.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.175.48.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['2620:4f:8000::', 48],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  blocked.addSubnet(network, prefix, 'ipv6')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')

/** Only global unicast space outside every special-purpose range counts as public. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4
    ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}

/** 127.0.0.0/8 or ::1 only; an IPv4-mapped or zoned spelling is not loopback here. */
export function isLoopbackAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return address.startsWith('127.')
  if (family !== 6 || address.includes('%')) return false
  try {
    return new URL(`http://[${address}]/`).hostname === '[::1]'
  } catch {
    return false
  }
}
