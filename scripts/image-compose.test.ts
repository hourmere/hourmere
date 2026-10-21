import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
// Source-copy mutation probes leave the tracked Compose files untouched.
const sources = {
  base: readFileSync(
    process.env.HOURMERE_BASE_COMPOSE_FILE ?? new URL('docker-compose.yml', root),
    'utf8',
  ),
  image: readFileSync(
    process.env.HOURMERE_IMAGE_COMPOSE_FILE ?? new URL('docker-compose.image.yml', root),
    'utf8',
  ),
  proxy: readFileSync(new URL('docker-compose.proxy.yml', root), 'utf8'),
  worker: readFileSync(
    process.env.HOURMERE_WORKER_COMPOSE_FILE ?? new URL('docker-compose.worker.yml', root),
    'utf8',
  ),
}
const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0

interface Service {
  image: string
  build?: { context: string }
  pull_policy?: string
  ports?: unknown[]
  environment: Record<string, string>
  networks: Record<string, unknown>
  depends_on?: Record<string, unknown>
}

function render(overlays: ('image' | 'proxy' | 'worker')[], env: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'hourmere-image-config-'))
  try {
    // Extends resolves the base file directly even if an overlay was selected first.
    writeFileSync(join(directory, 'docker-compose.yml'), sources.base)
    for (const overlay of overlays)
      writeFileSync(join(directory, `docker-compose.${overlay}.yml`), sources[overlay])
    writeFileSync(
      join(directory, '.env'),
      Object.entries({
        COMPOSE_FILE: [
          'docker-compose.yml',
          ...overlays.map((overlay) => `docker-compose.${overlay}.yml`),
        ].join(':'),
        POSTGRES_PASSWORD: 'synthetic-image-config-password',
        BETTER_AUTH_SECRET: 'synthetic-image-config-auth-secret-with-32-characters',
        PUBLIC_URL: 'https://image.example.test',
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
        basename(directory).toLowerCase(),
        'config',
        '--format',
        'json',
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      },
    )
    return {
      status: result.status,
      stderr: result.stderr,
      config:
        result.status === 0
          ? (JSON.parse(result.stdout) as { services: Record<string, Service> })
          : undefined,
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const combinations = [false, true].flatMap((image) =>
  [false, true].flatMap((proxy) =>
    [false, true].map((worker) => ({
      image,
      proxy,
      worker,
      overlays: [
        ...(image ? ['image' as const] : []),
        ...(proxy ? ['proxy' as const] : []),
        ...(worker ? ['worker' as const] : []),
      ],
    })),
  ),
)

describe.skipIf(!hasCompose)(
  'published image deployment (requires Compose CLI, no registry)',
  () => {
    it.each(combinations)(
      'renders image=$image proxy=$proxy worker=$worker without changing the source path',
      ({ image, proxy, worker, overlays }) => {
        const result = render(overlays, image ? { HOURMERE_VERSION: '1.2.3' } : {})
        expect(result.status, 'Compose must merge every supported deployment combination').toBe(0)
        const services = result.config?.services ?? {}
        const app = services.app
        expect(app).toBeDefined()
        expect(app?.image).toBe(image ? 'ghcr.io/hourmere/hourmere:1.2.3' : 'hourmere:local')
        expect(app?.pull_policy).toBe(image ? 'missing' : 'never')
        expect(Boolean(app?.build)).toBe(!image)
        if (app?.build) expect(app.build.context).toMatch(/hourmere-image-config-/)
        expect(app?.environment.AUTO_MIGRATE).toBe('true')
        expect(app?.environment.HOURMERE_ROLE).toBe(worker ? 'web' : '')
        expect(app?.ports ?? []).toHaveLength(proxy ? 0 : 1)
        expect(services.db?.ports ?? []).toEqual([])
        expect(Boolean(services.proxy)).toBe(proxy)
        expect(Boolean(services.worker)).toBe(worker)
        if (proxy) {
          expect(app?.environment.TRUSTED_PROXIES).toBe('172.30.62.2')
          expect(Object.keys(app?.networks ?? {})).toEqual(['default', 'ingress'])
        }
        if (worker) {
          expect(services.worker?.image).toBe(app?.image)
          expect(services.worker).not.toHaveProperty('build')
          expect(services.worker?.pull_policy).toBe('never')
          expect(services.worker?.environment).toEqual({
            ...app?.environment,
            // The worker does not inherit the proxy's dedicated ingress identity.
            TRUSTED_PROXIES: '',
            HOURMERE_ROLE: 'worker',
          })
          expect(services.worker?.ports ?? []).toEqual([])
          expect(Object.keys(services.worker?.networks ?? {})).toEqual(['default'])
          expect(services.worker?.depends_on).toEqual(app?.depends_on)
        }
      },
    )

    it.each(['1.0.0', '1.0.0-rc.1'])(
      'uses the exact selected release %s for app and worker despite APP_IMAGE',
      (version) => {
        const result = render(['image', 'proxy', 'worker'], {
          HOURMERE_VERSION: version,
          APP_IMAGE: 'hourmere:local-override',
        })
        expect(result.status).toBe(0)
        const { app, worker } = result.config?.services ?? {}
        for (const service of [app, worker]) {
          expect(service?.image).toBe(`ghcr.io/hourmere/hourmere:${version}`)
          expect(service?.image).toMatch(
            /^ghcr\.io\/hourmere\/hourmere:(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/,
          )
          expect(service).not.toHaveProperty('build')
        }
      },
    )

    it.each(['', undefined])('refuses an absent or empty required release (%j)', (version) => {
      const result = render(['image'], version === undefined ? {} : { HOURMERE_VERSION: version })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('HOURMERE_VERSION')
      expect(result.config).toBeUndefined()
    })

    it('retains the custom local image selection and build only on the source path', () => {
      const result = render(['proxy', 'worker'], { APP_IMAGE: 'hourmere:custom-source-build' })
      expect(result.status).toBe(0)
      expect(result.config?.services.app?.image).toBe('hourmere:custom-source-build')
      expect(result.config?.services.app?.build).toBeDefined()
      expect(result.config?.services.app?.pull_policy).toBe('never')
      expect(result.config?.services.worker?.image).toBe('hourmere:custom-source-build')
      expect(result.config?.services.worker).not.toHaveProperty('build')
      expect(result.config?.services.worker?.pull_policy).toBe('never')
    })
  },
)
