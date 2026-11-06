import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it } from 'vitest'
import type { loadConfig } from './config.ts'

async function copy(mutate: boolean): Promise<typeof loadConfig> {
  const url = new URL('./config.ts', import.meta.url)
  let source = readFileSync(url, 'utf8')
  const before =
    "PAID_BOOKINGS_ENABLED: optional(z.enum(['true', 'false'])).transform(\n      (value) => value === 'true',"
  expect(source.includes(before)).toBe(true)
  if (mutate)
    source = source.replace(before, before.replace("value === 'true'", "value !== 'false'"))
  source = stripTypeScriptTypes(source)
  const bindings: Record<string, unknown> = {}
  for (const match of [...source.matchAll(/^import\s*\{([\s\S]*?)\}\s*from '([^']+)'\n/gm)]) {
    const specifier = match[2] as string
    const imported = await import(
      specifier.startsWith('.') ? new URL(specifier, url).href : specifier
    )
    for (const binding of (match[1] as string)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)) {
      const [name, local] = binding.split(/\s+as\s+/)
      bindings[local ?? (name as string)] = imported[name as string]
    }
    source = source.replace(match[0], '')
  }
  return new Function(
    ...Object.keys(bindings),
    `${source.replace(/\bexport /g, '')}; return loadConfig`,
  )(...Object.values(bindings))
}

function assertDisabled(load: typeof loadConfig) {
  expect(
    load({
      DATABASE_URL: 'postgres://unused@localhost/unused',
      BETTER_AUTH_SECRET: 'synthetic'.repeat(8),
    }).PAID_BOOKINGS_ENABLED,
  ).toBe(false)
}

it('detects accidental default enablement in an isolated config source copy', async () => {
  assertDisabled(await copy(false))
  const mutated = await copy(true)
  expect(() => assertDisabled(mutated)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
})
