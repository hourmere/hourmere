import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { localeRegistry } from '../packages/core/src/locales.ts'

const document = readFileSync(new URL('../docs/user-content-direction.md', import.meta.url), 'utf8')
const preview = readFileSync(
  new URL('../apps/web/src/pages/routing-forms/RoutingFormPreview.tsx', import.meta.url),
  'utf8',
)

describe('user content direction inventory', () => {
  it('documents the registered interface directions', () => {
    const directions = [...new Set(Object.values(localeRegistry).map(({ direction }) => direction))]
    const documented = /^\| Registered interface directions \| (.*?) \|/m.exec(document)?.[1]
    expect(documented).toBe(directions.map((direction) => `\`${direction}\``).join(', '))
  })

  it.each([
    ['question label', /label=\{\s*<bdi\b[^>]*>\s*\{question\.label\}\s*<\/bdi>/],
    ['event title', /title\s*\?\s*<bdi\b[^>]*>\s*\{title\}\s*<\/bdi>/],
  ])('documents the existing routing preview %s boundary', (name, boundary) => {
    expect(document).toContain(`| Routing preview ${name} | \`<bdi>\` |`)
    expect(preview).toMatch(boundary)
  })
})
