import { isIP } from 'node:net'

export type WebhookPrivateTarget = Readonly<
  | { kind: 'host'; host: string; portStart: number; portEnd: number }
  | {
      kind: 'network'
      network: string
      family: 4 | 6
      prefix: number
      portStart: number
      portEnd: number
    }
>

function addressNumber(address: string): bigint | undefined {
  if (isIP(address) === 4)
    return address.split('.').reduce((value, octet) => (value << 8n) | BigInt(octet), 0n)
  if (isIP(address) !== 6 || address.includes('%') || address.includes('.')) return undefined
  const halves = address.split('::')
  const left = halves[0]?.split(':').filter(Boolean) ?? []
  const right = halves[1]?.split(':').filter(Boolean) ?? []
  const words =
    halves.length === 1
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
  return words.reduce((value, word: string) => (value << 16n) | BigInt(`0x${word}`), 0n)
}

function bounds(network: string, prefix: number, family: 4 | 6) {
  const address = addressNumber(network)
  if (address === undefined) return undefined
  const size = 1n << BigInt((family === 4 ? 32 : 128) - prefix)
  return { start: address, end: address + size - 1n, size }
}

const privateNetworks = [
  ['10.0.0.0', 8, 4],
  ['127.0.0.0', 8, 4],
  ['172.16.0.0', 12, 4],
  ['192.168.0.0', 16, 4],
  ['fc00::', 7, 6],
  ['::1', 128, 6],
] as const
const metadataV6 = addressNumber('fd00:ec2::254') as bigint

function eligibleNetwork(network: string, prefix: number, family: 4 | 6): boolean {
  const range = bounds(network, prefix, family)
  if (!range || range.start % range.size !== 0n) return false
  if (family === 6 && range.start <= metadataV6 && metadataV6 <= range.end) return false
  return privateNetworks.some(([base, length, version]) => {
    const allowed = bounds(base, length, version)
    return (
      version === family &&
      allowed !== undefined &&
      allowed.start <= range.start &&
      range.end <= allowed.end
    )
  })
}

/** Only ordinary private/loopback space; metadata, link-local and other special use stay denied. */
export function isWebhookPrivateAddress(address: string): boolean {
  const family = isIP(address)
  return (family === 4 || family === 6) && eligibleNetwork(address, family === 4 ? 32 : 128, family)
}

/** Parse the operator setting once at startup, without DNS or echoing supplied values. */
export function parseWebhookPrivateTargets(value?: string): readonly WebhookPrivateTarget[] {
  const invalid = () => new Error('Invalid WEBHOOK_PRIVATE_TARGETS setting')
  if (value === undefined || value.trim() === '') return Object.freeze([])
  const entries = value.split(',')
  if (entries.length > 32) throw invalid()
  const targets = entries.map((entry): WebhookPrivateTarget => {
    const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d+)(?:-(\d+))?$/.exec(entry.trim())
    if (!match) throw invalid()
    const address = match[1] ?? match[2] ?? ''
    const start = match[3] ?? ''
    const end = match[4] ?? start
    const portStart = Number(start)
    const portEnd = Number(end)
    if (
      !/^[1-9]\d{0,4}$/.test(start) ||
      !/^[1-9]\d{0,4}$/.test(end) ||
      portStart > 65535 ||
      portEnd > 65535 ||
      portStart > portEnd
    )
      throw invalid()
    const pieces = address.split('/')
    const network = pieces[0] ?? ''
    const family = isIP(network)
    if (family === 4 || family === 6) {
      if ((family === 6) !== Boolean(match[1]) || pieces.length > 2) throw invalid()
      const length = pieces[1]
      const prefix = length === undefined ? (family === 4 ? 32 : 128) : Number(length)
      if (
        (length !== undefined && !/^(?:0|[1-9]\d{0,2})$/.test(length)) ||
        prefix < 0 ||
        prefix > (family === 4 ? 32 : 128) ||
        !eligibleNetwork(network, prefix, family)
      )
        throw invalid()
      return Object.freeze({ kind: 'network', network, prefix, family, portStart, portEnd })
    }
    // Numeric-looking legacy IPv4 spellings must never become trusted DNS names.
    if (
      match[1] ||
      pieces.length !== 1 ||
      match[4] !== undefined ||
      address.length > 253 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i.test(address) ||
      address.split('.').some((label) => label.length > 63) ||
      /^[0-9.]+$/.test(address) ||
      /^0x[0-9a-f]+$/i.test(address)
    )
      throw invalid()
    try {
      if (new URL(`http://${address}/`).hostname !== address.toLowerCase()) throw invalid()
    } catch {
      throw invalid()
    }
    return Object.freeze({ kind: 'host', host: address.toLowerCase(), portStart, portEnd })
  })
  return Object.freeze(targets)
}

/** Creation is DNS-free: a hostname with a CIDR port is checked fully only at delivery. */
export function privateTargetCandidates(
  hostname: string,
  port: number,
  targets: readonly WebhookPrivateTarget[],
): readonly WebhookPrivateTarget[] {
  const literal = isIP(hostname)
  return targets.filter(
    (target) =>
      port >= target.portStart &&
      port <= target.portEnd &&
      (target.kind === 'host'
        ? target.host === hostname
        : !literal || privateTargetContains(target, hostname)),
  )
}

export function privateTargetContains(target: WebhookPrivateTarget, address: string): boolean {
  if (!isWebhookPrivateAddress(address)) return false
  if (target.kind === 'host') return true
  if (isIP(address) !== target.family) return false
  const range = bounds(target.network, target.prefix, target.family)
  const candidate = addressNumber(address)
  return (
    range !== undefined &&
    candidate !== undefined &&
    range.start <= candidate &&
    candidate <= range.end
  )
}
