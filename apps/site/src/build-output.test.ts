import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { attr, checkBuiltLinks, elements } from '../scripts/check-links.ts'
import { site } from './site.ts'

const siteRoot = fileURLToPath(new URL('../', import.meta.url))
// Astro moves prerendered assets with rename(), so output must stay on the source filesystem.
const scratch = mkdtempSync(join(siteRoot, 'node_modules/.hourmere-site-build-'))
const output = join(scratch, 'dist')
const trademarkNotice =
  'Calendly and Cal.com are trademarks of their respective owners; Hourmere is not affiliated with or endorsed by them.'
const text = (node: Element) => node.textContent?.replace(/\s+/g, ' ').trim()
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

beforeAll(() => {
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL('../../../node_modules/astro/bin/astro.mjs', import.meta.url)),
      'build',
      '--outDir',
      output,
    ],
    {
      cwd: siteRoot,
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
      stdio: 'pipe',
      timeout: 90_000,
    },
  )
}, 120_000)

describe('built website', () => {
  it.each(['index.html', 'privacy.html', 'terms.html', '404.html'])(
    'publishes the trademark notice as footer paragraph text in %s',
    (file) => {
      const document = new JSDOM(readFileSync(join(output, file), 'utf8')).window.document
      const notices = [...document.querySelectorAll('.site-footer p')].filter(
        (paragraph) => text(paragraph) === trademarkNotice,
      )
      expect(notices).toHaveLength(1)
      expect(notices[0]?.closest('[hidden], [aria-hidden="true"]')).toBeNull()
    },
  )

  it('publishes the comparison trademark notice in Product names and independence', () => {
    const document = new JSDOM(readFileSync(join(output, 'docs/comparison.html'), 'utf8')).window
      .document
    const nodes = [...document.querySelectorAll('.sl-markdown-content h2, .sl-markdown-content p')]
    const notices = nodes.filter((node) => node.tagName === 'P' && text(node) === trademarkNotice)
    expect(notices).toHaveLength(1)
    const notice = notices[0]
    if (!notice) throw new Error('Comparison trademark notice paragraph is missing')
    expect(notice.closest('[hidden], [aria-hidden="true"]')).toBeNull()
    const heading = nodes.slice(0, nodes.indexOf(notice)).findLast((node) => node.tagName === 'H2')
    expect(heading?.id).toBe('product-names-and-independence')
  })

  it('preserves the comparison independence statement for Cal.diy', () => {
    const document = new JSDOM(readFileSync(join(output, 'docs/comparison.html'), 'utf8')).window
      .document
    const statements = [...document.querySelectorAll('.sl-markdown-content p')].filter(
      (paragraph) =>
        text(paragraph) ===
        'Hourmere is not affiliated with or endorsed by Calendly, Cal.com or the Cal.diy project.',
    )
    expect(statements).toHaveLength(1)
    expect(statements[0]?.closest('[hidden], [aria-hidden="true"]')).toBeNull()
  })

  it('keeps the trademark notice out of ordinary documentation', () => {
    const document = new JSDOM(readFileSync(join(output, 'docs/rest.html'), 'utf8')).window.document
    expect(text(document.body)).not.toContain(trademarkNotice)
  })

  it('copies security.txt unchanged into the configured Workers assets build', () => {
    // Share one real site build with link checks rather than racing Astro's prerender directory.
    const config = JSON.parse(
      readFileSync(join(siteRoot, 'wrangler.jsonc'), 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n'),
    ) as {
      assets: { directory: string; not_found_handling: string }
    }
    expect(config.assets.not_found_handling).toBe('404-page')
    const assets = resolve(scratch, config.assets.directory)
    expect(readFileSync(join(assets, '.well-known/security.txt'), 'utf8')).toBe(
      readFileSync(join(siteRoot, 'public/.well-known/security.txt'), 'utf8'),
    )
    expect(readFileSync(join(assets, '_headers'), 'utf8')).toContain(
      '/.well-known/security.txt\n  Content-Type: text/plain; charset=utf-8\n',
    )
  })
  it('classifies documentation table cells and marks where long code may wrap', () => {
    const html = readFileSync(join(output, 'docs/configuration.html'), 'utf8')
    const nodes = elements(html)
    const cells = nodes.filter((node) => node.tagName === 'td')
    expect(cells.length).toBeGreaterThan(50)
    for (const cell of cells) {
      expect(['short', 'code', 'prose']).toContain(attr(cell, 'data-cell'))
      expect(['Variable', 'Default', 'Meaning', 'Purpose']).toContain(attr(cell, 'data-label'))
      expect(attr(cell, 'role')).toBe('cell')
    }
    expect(
      nodes.filter((node) => node.tagName === 'table').map((node) => attr(node, 'role')),
    ).toEqual(Array(7).fill('table'))
    // Identifiers stay whole; long code gains a <wbr> after each separator run.
    expect(html).toContain('<code dir="auto">DATABASE_URL</code>')
    expect(html).toContain('<code dir="auto">MICROSOFT_CALENDAR_CLIENT_SECRET</code>')
    expect(html).toContain('{PUBLIC_<wbr>URL}/<wbr>api/<wbr>auth/<wbr>callback/<wbr>google')
    expect(html).not.toContain('DATABASE_<wbr>URL')
  })

  it('resolves rendered internal links and anchors on apex and www, without trailing slashes', () => {
    const result = checkBuiltLinks(output)
    expect(result.pages).toBeGreaterThanOrEqual(15)
    expect(result.links).toBeGreaterThan(100)
    expect(result.errors).toEqual([])
  })

  it.each([
    'index.html',
    'privacy.html',
    'terms.html',
    '404.html',
    'docs.html',
    'docs/comparison.html',
  ])('publishes a complete raster sharing card and manifest in %s', (file) => {
    const nodes = elements(readFileSync(join(output, file), 'utf8'))
    const meta = (key: string) =>
      nodes
        .filter(
          (node) =>
            node.tagName === 'meta' &&
            (attr(node, 'property') === key || attr(node, 'name') === key),
        )
        .map((node) => attr(node, 'content'))
    for (const [key, value] of Object.entries({
      'og:image': site.socialImage.url,
      'og:image:width': '1200',
      'og:image:height': '630',
      'og:image:alt': site.socialImage.alt,
      'twitter:card': 'summary_large_image',
      'twitter:image': site.socialImage.url,
      'twitter:image:alt': site.socialImage.alt,
    }))
      expect(meta(key), `${file}: ${key}`).toEqual([value])
    expect(
      nodes.some(
        (node) => attr(node, 'rel') === 'manifest' && attr(node, 'href') === '/site.webmanifest',
      ),
    ).toBe(true)
  })
})

describe('rendered link checker controls', () => {
  it('catches missing paths, fragments, trailing slashes and a www canonical in a copied build', () => {
    const directory = mkdtempSync(join(scratch, 'controls-'))
    mkdirSync(join(directory, 'empty'))
    writeFileSync(join(directory, 'other.html'), '<h1 id="exists">Other</h1>')
    const control = join(directory, 'index.html')
    writeFileSync(
      control,
      '<h1 id="welcome">Hello</h1><a href="https://www.hourmere.com/#welcome">Home</a>',
    )
    expect(checkBuiltLinks(directory).errors).toEqual([])
    for (const [html, error] of [
      ['<a href="/missing">Missing</a>', 'missing target'],
      ['<a href="https://www.hourmere.com/#missing">Missing</a>', 'missing anchor'],
      ['<a href="/docs/">Docs</a>', 'trailing slash'],
      ['<link rel="canonical" href="https://www.hourmere.com/">', 'noncanonical URL'],
      ['<link rel="canonical" href="https://hourmere.com/?bad#bad">', 'noncanonical URL'],
      ['<a href="/empty">Directory</a>', 'missing target'],
      ['<a href="/other.html#missing">Other</a>', 'missing anchor'],
      ['<a href="/other.html#exists">Other</a>', 'noncanonical HTML path'],
    ] as const) {
      writeFileSync(control, html)
      expect(checkBuiltLinks(directory).errors.some((value) => value.includes(error ?? ''))).toBe(
        true,
      )
    }
    rmSync(directory, { recursive: true })
  })
})
