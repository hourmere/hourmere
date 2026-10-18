import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../apps/server/src/config.ts'

const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')
const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
const reference = readFileSync(
  new URL('../apps/site/src/content/docs/docs/configuration.md', import.meta.url),
  'utf8',
)

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
    const rows = reference.split('\n').filter((line) => /^\| `[A-Z_]+`/.test(line))
    const documented = new Set([
      ...Array.from(example.matchAll(/^([A-Z_]+)=/gm), (match) => match[1]),
      ...rows.flatMap((row) =>
        Array.from(row.split('|')[1]?.matchAll(/`([A-Z_]+)`/g) ?? [], (match) => match[1]),
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
        .filter((row) => row.includes('Not forwarded by the default Compose file'))
        .flatMap((row) =>
          Array.from(row.split('|')[1]?.matchAll(/`([A-Z_]+)`/g) ?? [], (match) => match[1]),
        ),
    )
    expect([...documented].filter((name) => !forwarded.has(name) && !excluded.has(name))).toEqual(
      [],
    )
    expect([...excluded].filter((name) => forwarded.has(name))).toEqual([])
  })

  it('passes the opt-in Zoom flag to app and its inherited worker with a false default', () => {
    expect(compose).toMatch(/^ {6}ZOOM_MEETINGS_ENABLED: \$\{ZOOM_MEETINGS_ENABLED:-false\}$/m)
  })

  it('forwards automatic migrations with the documented true default', () => {
    expect(composeAppEnvironment(compose).get('AUTO_MIGRATE')).toMatch(/^\$\{AUTO_MIGRATE:-true\}$/)
    const row = reference.split('\n').find((line) => line.startsWith('| `AUTO_MIGRATE` |'))
    expect(row).toContain('| `true` |')
    expect(row).toContain('Forwarded by the default Compose file with a default of `true`')
  })
})
