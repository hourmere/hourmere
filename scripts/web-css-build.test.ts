import { globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'

function queryHeaders(css: string) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...clean.matchAll(/@(?:media|container)\b[^{};]*(?=\{)/gi)].map(([header]) => header)
}

function widthRanges(css: string) {
  return queryHeaders(css).filter((header) => /\bwidth\s*[<>=]|[<>=]\s*width\b/i.test(header))
}

describe('production web CSS compatibility', () => {
  it.each([
    'width>=900px',
    'width < 400px',
    'width>900px',
    'width<=900px',
    'width=900px',
    '400px<=width',
    '400px < width',
    '900px>=width',
    '900px > width',
    '900px=width',
    '400px<=width<880px',
    '400px < width <= 880px',
  ])('detects unsupported width range syntax: %s', (condition) => {
    for (const kind of ['media', 'container']) {
      const header = `@${kind} (${condition})`
      expect(widthRanges(`${header}{.fixture{display:grid}}`)).toEqual([header])
    }
  })

  it('allows legacy min/max features and exclusive negated upper bounds', () => {
    expect(
      widthRanges(`
        @media (min-width: 640px) {.fixture{display:grid}}
        @media (max-width: 900px) {.fixture{display:block}}
        @container data-table not (min-width: 400px) {.fixture{display:block}}
        @container data-table (min-width: 400px) and (not (min-width: 880px)) {
          .fixture{display:grid}
        }
      `),
    ).toEqual([])
  })

  it('emits no media or container width ranges in any production CSS asset', async () => {
    const output = mkdtempSync(join(tmpdir(), 'hourmere-web-css-build-'))
    try {
      // Build the real application with its production config, including its CSS minifier.
      await build({
        configFile: resolve('apps/web/vite.config.ts'),
        root: resolve('apps/web'),
        logLevel: 'silent',
        build: { outDir: output },
      })
      const assets = globSync('**/*.css', { cwd: output })
      expect(assets.length).toBeGreaterThan(0)
      const headers: string[] = []
      for (const asset of assets) {
        const css = readFileSync(join(output, asset), 'utf8')
        expect(widthRanges(css), asset).toEqual([])
        headers.push(...queryHeaders(css))
      }
      expect(headers.some((header) => header.startsWith('@media'))).toBe(true)
      expect(headers.some((header) => header.startsWith('@container public-page'))).toBe(true)
      expect(headers.some((header) => header.startsWith('@container data-table'))).toBe(true)
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  }, 60_000)
})
