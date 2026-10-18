import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')
const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
const reference = readFileSync(
  new URL('../apps/site/src/content/docs/docs/configuration.md', import.meta.url),
  'utf8',
)

describe('documented Compose configuration', () => {
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
  })

  it('passes the opt-in Zoom flag to app and its inherited worker with a false default', () => {
    expect(compose).toMatch(/^ {6}ZOOM_MEETINGS_ENABLED: \$\{ZOOM_MEETINGS_ENABLED:-false\}$/m)
  })
})
