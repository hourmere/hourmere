// @vitest-environment node
import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build, loadConfigFromFile } from 'vite'
import { describe, expect, it } from 'vitest'

const sourceRoot = resolve('apps/web/src')
const sheets = globSync('**/*.css', { cwd: sourceRoot }).map((path) => ({
  path,
  source: readFileSync(resolve(sourceRoot, path), 'utf8'),
}))
const styles = sheets.find(({ path }) => path === 'styles.css')?.source ?? ''

type Block = { selector: string; body: string; parents: string[] }

// Walk balanced blocks, including nested media/supports rules. Strings may contain braces.
function blocks(source: string, parents: string[] = []): Block[] {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const result: Block[] = []
  let start = 0
  for (let cursor = 0; cursor < clean.length; cursor++) {
    if (clean[cursor] !== '{') continue
    const selector = clean.slice(start, cursor).split(';').at(-1)?.trim() ?? ''
    const bodyStart = cursor + 1
    let depth = 1
    let quote = ''
    for (cursor++; cursor < clean.length && depth; cursor++) {
      const char = clean[cursor]
      if (char === '\\') {
        cursor++
      } else if (quote) {
        if (char === quote) quote = ''
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '{') {
        depth++
      } else if (char === '}') {
        depth--
      }
    }
    const body = clean.slice(bodyStart, cursor - 1)
    result.push({ selector, body, parents })
    if (selector.startsWith('@')) result.push(...blocks(body, [...parents, selector]))
    start = cursor
  }
  return result
}

const parsed = blocks(styles)
function rule(selector: string, parent?: string) {
  const match = parsed.find(
    (block) =>
      block.selector === selector &&
      (parent ? block.parents.includes(parent) : block.parents.length === 0),
  )
  expect(match, `missing ${parent ?? 'base'} rule: ${selector}`).toBeDefined()
  return match?.body ?? ''
}

describe('responsive shell and shared CSS contract', () => {
  it('uses only whitelisted mobile-first viewport widths in every web stylesheet', () => {
    for (const { path, source } of sheets) {
      const media = blocks(source).filter(({ selector }) => selector.startsWith('@media'))
      for (const { selector } of media) {
        if (!/\bwidth\b/i.test(selector)) continue
        expect(selector, path).toMatch(/\(min-width:\s*(480|640|960|1280|1600)px\)/)
        expect(selector, path).not.toMatch(/max-width|\bwidth\s*[<>=]|[<>=]\s*width\b/i)
        expect(
          selector.replace(/\(min-width:\s*(480|640|960|1280|1600)px\)/g, ''),
          path,
        ).not.toMatch(/\bwidth\b/i)
        const widths = [...selector.matchAll(/\bmin-width:\s*([^)]*)\)/gi)]
        expect(widths.length, `${path}: ${selector}`).toBeGreaterThan(0)
        for (const width of widths) expect(width[1], path).toMatch(/^(480|640|960|1280|1600)px$/)
      }
    }
    // Component container queries retain their own content-driven thresholds.
    expect(styles).toContain('@container data-table (max-width: 639.98px)')
  })

  it('gates every hover selector behind actual hover capability', () => {
    for (const { path, source } of sheets) {
      for (const { selector, parents } of blocks(source)) {
        if (!selector.includes(':hover')) continue
        expect(parents, `${path}: ${selector}`).toContain('@media (hover: hover)')
      }
    }
    // Selection is also available without a pointer hovering over it.
    expect(rule('.combobox-option[aria-selected="true"]')).toContain(
      'background: var(--accent-soft);',
    )
  })

  it('defines centered shell, list and editor container tokens', () => {
    const tokens = rule(':root')
    for (const [token, value] of [
      ['content-narrow', '720px'],
      ['content', '960px'],
      ['content-wide', '1200px'],
      ['shell-max', '1440px'],
    ]) {
      expect(tokens).toContain(`--${token}: ${value};`)
    }
    for (const selector of ['.topbar-inner', '.layout']) {
      expect(rule(selector)).toContain('max-width: var(--shell-max);')
      expect(rule(selector)).toContain('margin-inline: auto;')
    }
    expect(rule('main')).toContain('margin-inline: auto;')
    expect(rule('.main-content')).toContain('max-width: var(--content);')
    expect(rule('.main-content-wide')).toContain('max-width: var(--content-wide);')
  })

  it('keeps the compact topbar in flow on phones and in short windows', () => {
    expect(rule('.topbar')).toContain('position: static;')
    expect(rule('.topbar', '@media (min-width: 640px)')).toContain('position: sticky;')
    expect(rule('.topbar', '@media (max-height: 500px)')).toContain('position: static;')
    expect(rule('html')).toContain(
      'scroll-padding-top: calc(var(--topbar-height) + 1px + var(--space-2));',
    )
    expect(rule('.topbar-inner')).toContain('display: flex;')
    expect(rule('.topbar-inner')).not.toContain('flex-wrap: wrap;')
    expect(rule('.account-email')).toContain('display: none;')
    expect(rule('.account-email', '@media (min-width: 960px)')).toContain('display: block;')
    expect(rule('.topbar .logo-word')).toContain('display: none;')
    expect(rule('.topbar .logo-word', '@media (min-width: 480px)')).toContain('display: inline;')
    expect(rule('.language-picker')).toContain('white-space: nowrap;')
    expect(
      rule('.language-picker-compact > span,\n.card-header .language-picker > span'),
    ).toContain('clip-path: inset(50%);')
    expect(rule('.language-picker-compact > span', '@media (min-width: 960px)')).toContain(
      'clip-path: none;',
    )
  })

  it('shows the sidebar at 960px and gives its sticky list bounded vertical scrolling', () => {
    const desktop = '@media (min-width: 960px)'
    expect(rule('.layout')).toContain('grid-template-columns: minmax(0, 1fr);')
    expect(rule('.layout', desktop)).toContain(
      'grid-template-columns: var(--sidebar-width) minmax(0, 1fr);',
    )
    expect(rule('.sidenav ul', desktop)).toContain('position: sticky;')
    expect(rule('.sidenav ul', desktop)).toContain(
      'max-height: calc(100vh - var(--topbar-height));',
    )
    expect(rule('.sidenav ul', desktop)).toContain('overflow-y: auto;')
    expect(rule('.sidenav a', desktop)).toContain('white-space: normal;')
    expect(rule('.sidenav a', desktop)).toContain('overflow-wrap: anywhere;')
    expect(rule('.sidenav ul', '@media (max-height: 500px)')).toContain('top: 0;')
  })

  it('reveals overflowing horizontal navigation with noninteractive edge fades', () => {
    expect(rule('.sidenav::before,\n.sidenav::after')).toContain('pointer-events: none;')
    expect(rule('.sidenav::before')).toContain(
      'linear-gradient(to right, var(--surface), transparent)',
    )
    expect(rule('.sidenav::after')).toContain(
      'linear-gradient(to left, var(--surface), transparent)',
    )
    expect(
      rule(
        '.sidenav[data-scroll-start="false"]::before,\n.sidenav[data-scroll-end="false"]::after',
      ),
    ).toContain('opacity: 1;')
    expect(rule('.sidenav ul')).toContain('scroll-padding-inline: var(--space-5);')
    expect(rule('.sidenav a')).toContain('scroll-margin-inline: var(--space-5);')
    expect(rule('.sidenav::before,\n  .sidenav::after', '@media (min-width: 960px)')).toContain(
      'display: none;',
    )
  })

  it('respects the body text preference and keeps every editable field at least 16px', () => {
    expect(rule('body')).toContain('font-size: var(--text-md);')
    for (const selector of [
      'input,\nselect,\ntextarea',
      'input.mono,\nselect.mono,\ntextarea.mono',
      '.language-picker select',
    ]) {
      expect(rule(selector)).toContain('font-size: max(16px, var(--text-md));')
    }
    expect(rule('input,\nselect,\ntextarea')).toContain('min-width: 0;')
  })

  it('gives compact buttons, checkbox labels and small links 44px touch targets', () => {
    const coarse = '@media (pointer: coarse)'
    const controls = rule(
      '.button,\n  .button-small,\n  input:not([type="checkbox"]):not([type="radio"]),\n  select,\n  .sidenav a,\n  .tabs a,\n  .topbar .brand,\n  .checkbox,\n  label.choice',
      coarse,
    )
    expect(controls).toContain('min-height: 44px;')
    expect(controls).toContain('min-width: 44px;')
    const links = rule(
      '.breadcrumb a,\n  .booking-link a,\n  .fine-print a,\n  .public-footer a,\n  .public-signup a,\n  .legal-links a',
      coarse,
    )
    expect(links).toContain('min-height: 44px;')
    expect(links).toContain('min-width: 44px;')
    expect(links).toContain('display: inline-flex;')
  })

  it('retains viewport fallbacks while preferring the small viewport height', () => {
    expect(rule('.centered')).toContain('min-height: 100vh;')
    expect(rule('.centered', '@supports (height: 100svh)')).toContain('min-height: 100svh;')
    expect(rule('.sidenav', '@supports (height: 100svh)')).toContain(
      'min-height: calc(100svh - var(--topbar-height));',
    )
    expect(rule('.sidenav ul', '@supports (height: 100svh)')).toContain(
      'max-height: calc(100svh - var(--topbar-height));',
    )
    const publicSheet = sheets.find(({ path }) => path === 'public/public.css')?.source ?? ''
    const publicRules = blocks(publicSheet)
    expect(publicRules.find(({ selector }) => selector === '.public')?.body).toContain(
      'min-height: 100vh;',
    )
    expect(
      publicRules.find(
        ({ selector, parents }) =>
          selector === '.public' && parents.includes('@supports (height: 100svh)'),
      )?.body,
    ).toContain('min-height: 100svh;')
  })

  it('allows centered cards and their headers to reflow inside a 320px viewport', () => {
    expect(rule('.centered')).toContain('grid-template-columns: minmax(0, 1fr);')
    expect(rule('.card')).toContain('min-width: 0;')
    expect(rule('.card')).toContain('overflow-wrap: anywhere;')
    const header = rule('.card-header')
    expect(header).toContain('display: flex;')
    expect(header).toContain('flex-wrap: wrap;')
    expect(header).toContain('justify-content: space-between;')
    expect(header).toContain('gap: var(--space-3);')
    expect(rule('.details')).toContain('grid-template-columns: minmax(0, 1fr);')
    expect(rule('.details', '@media (min-width: 480px)')).toContain(
      'grid-template-columns: max-content minmax(0, 1fr);',
    )
  })

  it('emits legacy media syntax through the configured production CSS pipeline', async () => {
    const loaded = await loadConfigFromFile(
      { command: 'build', mode: 'production' },
      resolve('apps/web/vite.config.ts'),
    )
    expect(loaded).not.toBeNull()
    const result = await build({
      ...loaded?.config,
      root: resolve('apps/web'),
      configFile: false,
      publicDir: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'layout-contract-fixture',
          resolveId(id) {
            if (id.startsWith('virtual:layout-contract')) return `\0${id}`
          },
          load(id) {
            if (id === '\0virtual:layout-contract') return "import 'virtual:layout-contract.css'"
            if (id === '\0virtual:layout-contract.css') {
              return '@media (min-width: 640px) { .fixture { display: grid; } }'
            }
          },
        },
      ],
      build: {
        ...loaded?.config.build,
        write: false,
        cssCodeSplit: false,
        rolldownOptions: { input: 'virtual:layout-contract' },
      },
    })
    const bundles = Array.isArray(result) ? result : [result]
    const css = bundles.flatMap((bundle) => {
      if (!('output' in bundle)) throw new Error('unexpected watch build')
      return bundle.output
        .filter((entry) => entry.type === 'asset' && entry.fileName.endsWith('.css'))
        .map((entry) => (entry.type === 'asset' ? String(entry.source) : ''))
    })
    expect(css).toHaveLength(1)
    expect(css[0]).toMatch(/@media\s*\(min-width:\s*640px\)/)
    expect(css[0]).not.toMatch(/\bwidth\s*[<>=]|[<>=]\s*width\b/)
  })
})
