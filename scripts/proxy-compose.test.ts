import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const base = readFileSync(new URL('docker-compose.yml', root), 'utf8')
const proxy = readFileSync(new URL('docker-compose.proxy.yml', root), 'utf8')
const worker = readFileSync(new URL('docker-compose.worker.yml', root), 'utf8')
const caddy = readFileSync(new URL('Caddyfile', root), 'utf8')
const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0

interface Service {
  image?: string
  build?: { context: string }
  pull_policy?: string
  ports?: { host_ip?: string; published: string; target: number; protocol: string }[]
  environment: Record<string, string>
  networks: Record<string, { ipv4_address?: string }>
  volumes?: { source: string; target: string }[]
  depends_on?: Record<string, unknown>
  restart?: string
  stop_grace_period?: string
}

// Interpolate synthetic values in an isolated directory, never the operator's .env.
// This uses Compose's real merge semantics; it needs the CLI, but no Docker daemon.
function render(overrides: ('proxy' | 'worker')[] = [], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hourmere-proxy-config-'))
  try {
    writeFileSync(join(dir, 'docker-compose.yml'), base)
    const files = ['docker-compose.yml']
    for (const override of overrides) {
      const file = `docker-compose.${override}.yml`
      writeFileSync(join(dir, file), override === 'proxy' ? proxy : worker)
      files.push(file)
    }
    writeFileSync(
      join(dir, '.env'),
      Object.entries({
        COMPOSE_FILE: files.join(':'),
        POSTGRES_PASSWORD: 'synthetic-compose-password',
        BETTER_AUTH_SECRET: 'synthetic-compose-auth-secret-32-characters',
        PUBLIC_URL: 'https://deploy.example.test',
        ...env,
      })
        .map(([key, value]) => `${key}='${value.replaceAll("'", "\\'")}'`)
        .join('\n'),
    )
    const result = spawnSync(
      'docker',
      [
        'compose',
        '--env-file',
        '.env',
        '-p',
        basename(dir).toLowerCase(),
        'config',
        '--format',
        'json',
      ],
      {
        cwd: dir,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      },
    )
    expect(result.status, 'Compose must merge the deployment files successfully').toBe(0)
    return JSON.parse(result.stdout) as {
      services: Record<'app' | 'db' | 'proxy' | 'worker', Service>
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
    expect(services.worker).toBeUndefined()
  })

  it('publishes only the TLS proxy, preserves certificates and trusts only its address', () => {
    const { services, volumes, networks } = render(['proxy'])
    expect(services.app.ports ?? []).toEqual([])
    expect(services.db.ports ?? []).toEqual([])
    expect(services.worker).toBeUndefined()
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
    const { services, networks } = render(['proxy'], {
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

it('keeps the optional worker out of the base Compose file', () => {
  expect(base).not.toMatch(/^\s*(?:#\s*)?worker:/m)
})

describe.skipIf(!hasCompose)('separate worker deployment (requires Compose CLI)', () => {
  it.each(['plain', 'proxy'] as const)(
    'shares app image, configuration and secret handling in the %s deployment',
    (deployment) => {
      const env = {
        APP_IMAGE: 'hourmere:isolated-worker-test',
        POSTGRES_PASSWORD: 'synthetic /#?$ database password',
        SMTP_URL: 'smtp://synthetic:smtp-password@mail.example.test:587',
        CALENDAR_ENCRYPTION_KEY: 'synthetic-calendar-key',
        CONFERENCE_ENCRYPTION_KEY: 'synthetic-conference-key',
        WEBHOOK_ENCRYPTION_KEY: 'synthetic-webhook-key',
        ZOOM_WEBHOOK_SECRET_TOKEN: 'synthetic-zoom-webhook-token',
        ZOOM_MEETINGS_ENABLED: 'true',
        HOURMERE_ROLE: 'all',
      }
      const baseApp = render([], env).services.app
      const { services } = render(deployment === 'proxy' ? ['proxy', 'worker'] : ['worker'], env)
      expect(services.app.environment.HOURMERE_ROLE).toBe('web')
      expect(services.worker.environment).toEqual({
        ...baseApp.environment,
        HOURMERE_ROLE: 'worker',
      })
      expect(services.worker.environment.DATABASE_URL).toBe('postgres://hourmere@db:5432/hourmere')
      // Compose escapes literal dollars in config output so that it can be loaded again.
      expect(services.worker.environment.PGPASSWORD?.replaceAll('$$', '$')).toBe(
        env.POSTGRES_PASSWORD,
      )
      expect(services.app.image).toBe(env.APP_IMAGE)
      expect(services.worker.image).toBe(services.app.image)
      expect(services.app.build).toBeDefined()
      expect(services.worker).not.toHaveProperty('build')
      expect(services.worker.pull_policy).toBe('never')
      expect(services.worker.ports ?? []).toEqual([])
      expect(Object.keys(services.worker.networks)).toEqual(['default'])
      expect(services.worker.depends_on).toEqual(baseApp.depends_on)
      expect(services.worker.restart).toBe('unless-stopped')
      expect(services.worker.stop_grace_period).toBe('35s')
      expect(services.db.ports ?? []).toEqual([])
      if (deployment === 'proxy') {
        expect(services.app.ports ?? []).toEqual([])
        expect(Object.keys(services.app.networks)).toEqual(['default', 'ingress'])
        expect(services.proxy.image).toBe('caddy:2.11-alpine')
      }
    },
  )

  it.each(['', 'all', 'web', 'worker'])(
    'runs jobs only in the worker despite HOURMERE_ROLE=%j in .env',
    (role) => {
      const { services } = render(['proxy', 'worker'], { HOURMERE_ROLE: role })
      expect(services.app.environment.HOURMERE_ROLE).toBe('web')
      expect(services.worker.environment.HOURMERE_ROLE).toBe('worker')
    },
  )
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
