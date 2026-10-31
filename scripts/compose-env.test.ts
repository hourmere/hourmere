import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../apps/server/src/config.ts'

const compose = readFileSync(
  process.env.HOURMERE_BASE_COMPOSE_FILE ?? new URL('../docker-compose.yml', import.meta.url),
  'utf8',
)
const worker = readFileSync(
  process.env.HOURMERE_WORKER_COMPOSE_FILE ??
    new URL('../docker-compose.worker.yml', import.meta.url),
  'utf8',
)
const example = readFileSync(
  process.env.HOURMERE_EXAMPLE_ENV_FILE ?? new URL('../.env.example', import.meta.url),
  'utf8',
)
const reference = readFileSync(
  new URL('../apps/site/src/content/docs/docs/configuration.md', import.meta.url),
  'utf8',
)
const referenceRows = reference
  .split('\n')
  .filter((line) => line.startsWith('|'))
  .map((line) =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim()),
  )

/** Match one complete variable cell and preserve the default and description boundaries. */
function documentedVariable(name: string): string[] {
  const rows = referenceRows.filter(([variable]) => variable === `\`${name}\``)
  expect(rows, `One configuration reference row for ${name}`).toHaveLength(1)
  const row = rows[0] ?? []
  expect(row, `Variable, default and description cells for ${name}`).toHaveLength(3)
  return row
}

/**
 * Parse the explicit app.environment mapping without interpolating .env or asking Docker
 * to read it. Fail on other YAML forms so an unparsed anchor/list cannot pass this guard.
 */
function composeAppEnvironment(compose: string): Map<string, string> {
  const lines = compose.split('\n')
  const app = lines.indexOf('  app:')
  expect(app, 'Compose must define the app service').toBeGreaterThan(-1)
  const environment = lines.findIndex((line, i) => i > app && line === '    environment:')
  expect(environment, 'Compose app must have an explicit environment mapping').toBeGreaterThan(app)
  const variables = new Map<string, string>()
  for (const line of lines.slice(environment + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (!line.startsWith('      ')) break
    const entry = /^ {6}([A-Z][A-Z0-9_]*): (.+)$/.exec(line)
    const key = entry?.[1]
    const value = entry?.[2]
    if (!key || !value) throw new Error('Unsupported Compose environment mapping entry')
    expect(variables.has(key), `Duplicate Compose environment variable ${key}`).toBe(false)
    variables.set(key, value)
  }
  return variables
}

describe('documented Compose configuration', () => {
  it('describes image and source selections in the environment template', () => {
    expect(example).toContain('setup.sh --source selects a local build')
    expect(example).toContain(
      'setup.sh --image adds docker-compose.image.yml and writes an exact HOURMERE_VERSION',
    )
    expect(example).toContain('image installs omit --build; source installs include --build')
    expect(example).toContain(
      'Keep the existing files in the list, including docker-compose.image.yml for an image install',
    )
    expect(example).toContain(
      'Optional source-build image tag; ignored by docker-compose.image.yml',
    )
    expect(example).toContain('exact release version here (without v); it must match')
    expect(example).toContain('the exact checkout tag when present')
    expect(example).toContain('Keep unset for setup.sh --source; never select a moving tag')
    expect(example).toMatch(/^# HOURMERE_VERSION=1\.0\.0$/m)
    expect(example).not.toMatch(/^HOURMERE_VERSION=/m)
  })

  it('describes setup commands for both paths in the base Compose header', () => {
    const header = compose.split('name: hourmere')[0]
    expect(header).toContain(
      '--image selects docker-compose.image.yml and an exact HOURMERE_VERSION; start without --build',
    )
    expect(header).toContain(
      '--source builds this checkout with docker compose up -d --build --wait',
    )
    expect(header).toContain('prints the next commands')
  })

  it('preserves image selection and follows the matching worker startup hint', () => {
    const header = worker.split('services:')[0]
    expect(header).toContain('./scripts/enable-worker.sh after setup.sh')
    expect(header).toContain('image installs omit --build; source installs include --build')
    expect(header).toContain(
      'Preserve docker-compose.image.yml in the file list for an image install',
    )
  })

  it('forwards every loadConfig environment input, apart from explicit container settings', () => {
    // Zod reads every declared input, including absent optionals. Discover those reads
    // from the real loader so adding a setting automatically extends this contract.
    const inputs = new Set<string>()
    loadConfig(
      new Proxy<NodeJS.ProcessEnv>(
        {
          DATABASE_URL: 'postgres://synthetic@localhost:9/config-contract',
          BETTER_AUTH_SECRET: 'synthetic-config-contract-value-32',
        },
        {
          get(env, key, receiver) {
            if (typeof key === 'string' && /^[A-Z][A-Z0-9_]*$/.test(key)) inputs.add(key)
            return Reflect.get(env, key, receiver)
          },
        },
      ),
    )
    expect(inputs.size).toBeGreaterThan(30)
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
    const environment = composeAppEnvironment(compose)
    // Compose publishes a configurable host port but the image always listens on 3000;
    // the static web assets live at an image-owned path. Neither is an operator override.
    expect(dockerfile).toMatch(/\bPORT=3000\b/)
    expect(dockerfile).toContain('WEB_DIST=/app/apps/web/dist')
    expect(compose).toMatch(/127\.0\.0\.1:\$\{PORT:-3000\}:3000/)
    // The database hostname belongs to Compose; its password is forwarded separately.
    expect(environment.get('DATABASE_URL')).toBe('postgres://hourmere@db:5432/hourmere')
    expect(environment.get('PGPASSWORD')).toMatch(/^\$\{POSTGRES_PASSWORD[}:?]/)
    for (const key of inputs) {
      if (['DATABASE_URL', 'PORT', 'WEB_DIST'].includes(key)) continue
      expect(environment.get(key) ?? '', `Compose must forward loadConfig input ${key}`).toMatch(
        new RegExp(`^\\$\\{${key}(?:[:?}-])`),
      )
    }
  })

  it('forwards every documented variable or explicitly documents its exclusion', () => {
    const rows = referenceRows.filter(([variable]) => /^`[A-Z_]+`/.test(variable ?? ''))
    const documented = new Set([
      ...Array.from(example.matchAll(/^([A-Z_]+)=/gm), (match) => match[1]),
      ...rows.flatMap((row) =>
        Array.from(row[0]?.matchAll(/`([A-Z_]+)`/g) ?? [], (match) => match[1]),
      ),
    ])
    const active = compose
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
    const forwarded = new Set([
      ...Array.from(active.matchAll(/^\s+([A-Z_]+):/gm), (match) => match[1]),
      ...Array.from(active.matchAll(/\$\{([A-Z_]+)(?=[:}])/g), (match) => match[1]),
    ])
    const excluded = new Set(
      rows
        .filter((row) =>
          row.some((cell) => cell.includes('Not forwarded by the default Compose file')),
        )
        .flatMap((row) => Array.from(row[0]?.matchAll(/`([A-Z_]+)`/g) ?? [], (match) => match[1])),
    )
    expect([...documented].filter((name) => !forwarded.has(name) && !excluded.has(name))).toEqual(
      [],
    )
    expect([...excluded].filter((name) => forwarded.has(name))).toEqual([])
  })

  it('passes the opt-in Zoom flag to app and its inherited worker with a false default', () => {
    expect(compose).toMatch(/^ {6}ZOOM_MEETINGS_ENABLED: \$\{ZOOM_MEETINGS_ENABLED:-false\}$/m)
  })

  it('forwards operator policy links without supplying a hosted policy for self-hosted instances', () => {
    const environment = composeAppEnvironment(compose)
    for (const key of ['PRIVACY_POLICY_URL', 'TERMS_URL']) {
      expect(environment.get(key)).toBe(`\${${key}:-}`)
      expect(example).toMatch(new RegExp(`^${key}=$`, 'm'))
      expect(documentedVariable(key)[1]).toBe('Unset')
    }
  })

  it('forwards the optional Zoom webhook token without enabling it by default', () => {
    expect(composeAppEnvironment(compose).get('ZOOM_WEBHOOK_SECRET_TOKEN') ?? '').toMatch(
      /^\$\{ZOOM_WEBHOOK_SECRET_TOKEN:-\}$/,
    )
    expect(example).toMatch(/^ZOOM_WEBHOOK_SECRET_TOKEN=$/m)
    expect(documentedVariable('ZOOM_WEBHOOK_SECRET_TOKEN')[1]).toBe('Unset')
  })

  it('keeps private webhook destinations empty by default', () => {
    expect(composeAppEnvironment(compose).get('WEBHOOK_PRIVATE_TARGETS') ?? '').toMatch(
      /^\$\{WEBHOOK_PRIVATE_TARGETS:-\}$/,
    )
    expect(example).toMatch(/^WEBHOOK_PRIVATE_TARGETS=$/m)
    expect(documentedVariable('WEBHOOK_PRIVATE_TARGETS')[1]).toBe('Unset')
    expect(reference).toContain('Hourmere Cloud MUST NEVER set')
  })

  it('forwards automatic migrations with the documented true default', () => {
    expect(composeAppEnvironment(compose).get('AUTO_MIGRATE')).toMatch(/^\$\{AUTO_MIGRATE:-true\}$/)
    const row = documentedVariable('AUTO_MIGRATE')
    expect(row[1]).toBe('`true`')
    expect(row[2]).toContain('Forwarded by the default Compose file with a default of `true`')
  })
})
