import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const base = readFileSync(new URL('docker-compose.yml', root), 'utf8')
const proxy = readFileSync(new URL('docker-compose.proxy.yml', root), 'utf8')
const caddy = readFileSync(new URL('Caddyfile', root), 'utf8')
const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0

interface Service {
  image?: string
  ports?: { host_ip?: string; published: string; target: number; protocol: string }[]
  environment: Record<string, string>
  networks: Record<string, { ipv4_address?: string }>
  volumes?: { source: string; target: string }[]
}

// Interpolate synthetic values in an isolated directory, never the operator's .env.
// This uses Compose's real merge semantics; it needs the CLI, but no Docker daemon.
function render(override?: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hourmere-proxy-config-'))
  try {
    writeFileSync(join(dir, 'docker-compose.yml'), base)
    writeFileSync(join(dir, '.env'), '')
    const files = ['-f', 'docker-compose.yml']
    if (override) {
      writeFileSync(join(dir, 'docker-compose.proxy.yml'), override)
      files.push('-f', 'docker-compose.proxy.yml')
    }
    const result = spawnSync('docker', ['compose', ...files, 'config', '--format', 'json'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        POSTGRES_PASSWORD: 'synthetic-compose-password',
        BETTER_AUTH_SECRET: 'synthetic-compose-auth-secret-32-characters',
        PUBLIC_URL: 'https://deploy.example.test',
        ...env,
      },
    })
    expect(result.status, 'Compose must merge the deployment files successfully').toBe(0)
    return JSON.parse(result.stdout) as {
      services: Record<'app' | 'db' | 'proxy', Service>
      networks: Record<string, { ipam: { config: { subnet: string; ip_range: string }[] } }>
      volumes: Record<string, unknown>
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(!hasCompose)('Caddy deployment (requires Compose CLI)', () => {
  it('keeps the plain deployment on loopback with an unpublished database', () => {
    const { services } = render()
    expect(services.app.ports).toEqual([
      expect.objectContaining({ host_ip: '127.0.0.1', published: '3000', target: 3000 }),
    ])
    expect(services.db.ports ?? []).toEqual([])
    expect(services.proxy).toBeUndefined()
  })

  it('publishes only the TLS proxy, preserves certificates and trusts only its address', () => {
    const { services, volumes, networks } = render(proxy)
    expect(services.app.ports ?? []).toEqual([])
    expect(services.db.ports ?? []).toEqual([])
    expect(
      services.proxy.ports?.map(({ published, target, protocol }) => [published, target, protocol]),
    ).toEqual([
      ['80', 80, 'tcp'],
      ['443', 443, 'tcp'],
      ['443', 443, 'udp'],
    ])
    expect(services.proxy.image).toBe('caddy:2.11-alpine')
    expect(services.app.environment.TRUSTED_PROXIES).toBe('172.30.62.2')
    expect(services.proxy.networks.ingress?.ipv4_address).toBe('172.30.62.2')
    expect(networks.ingress?.ipam.config).toEqual([
      { subnet: '172.30.62.0/28', ip_range: '172.30.62.8/29' },
    ])
    expect(Object.keys(services.proxy.networks)).toEqual(['ingress'])
    expect(Object.keys(services.db.networks)).toEqual(['default'])
    expect(volumes).toHaveProperty('caddy-data')
    expect(volumes).toHaveProperty('caddy-config')
    expect(services.proxy.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'caddy-data', target: '/data' }),
        expect.objectContaining({ source: 'caddy-config', target: '/config' }),
      ]),
    )
  })

  it('moves proxy identity and app trust together when avoiding a network overlap', () => {
    const { services, networks } = render(proxy, {
      PROXY_SUBNET: '172.30.63.0/28',
      PROXY_IP: '172.30.63.2',
      PROXY_DYNAMIC_RANGE: '172.30.63.8/29',
      TRUSTED_PROXIES: '0.0.0.0/0',
      APP_IMAGE: 'hourmere:isolated-deploy-test',
    })
    expect(networks.ingress?.ipam.config).toEqual([
      { subnet: '172.30.63.0/28', ip_range: '172.30.63.8/29' },
    ])
    expect(services.proxy.networks.ingress?.ipv4_address).toBe('172.30.63.2')
    expect(services.app.environment.TRUSTED_PROXIES).toBe('172.30.63.2')
    expect(services.app).toHaveProperty('image', 'hourmere:isolated-deploy-test')
  })
})

it('routes the complete public HTTPS origin with Caddy forwarding defaults', () => {
  const active = caddy
    .split('\n')
    .filter((line) => line.trim() && !line.trimStart().startsWith('#'))
    .join('\n')
  expect(active).toBe(
    String.raw`{
	log default {
		format filter {
			request>uri regexp "\?.*$" "?REDACTED"
			request>headers delete
		}
	}
}
{$PUBLIC_URL} {
	reverse_proxy app:3000
}`,
  )
})
