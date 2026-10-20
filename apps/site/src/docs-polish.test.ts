import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import postcss, { type Rule } from 'postcss'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { siteCopy } from './ui-copy.ts'

const root = process.env.HOURMERE_DOCS_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))
const read = (path: string) => readFileSync(join(root, 'apps/site', path), 'utf8')
const css = postcss.parse(read('src/styles/starlight.css'))

// Rules matching the selector; `within` restricts them to an at-rule (name and params) or,
// with null, to the unconditional top level.
function rules(selector: string, within?: string | null) {
  const matches: Rule[] = []
  css.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return
    const parent = rule.parent?.type === 'atrule' ? rule.parent : undefined
    const context = parent ? `@${parent.name} ${parent.params}` : null
    if (within !== undefined && context !== within) return
    matches.push(rule)
  })
  expect(
    matches.length,
    `${selector} has an override${within ? ` in ${within}` : ''}`,
  ).toBeGreaterThan(0)
  return matches
}

function declaration(selector: string, property: string, within?: string | null) {
  const values: string[] = []
  for (const rule of rules(selector, within)) {
    rule.walkDecls(property, (decl) => {
      values.push(decl.value)
    })
  }
  return values.at(-1)
}

const cards = '@container docs (max-width: 39rem)'

function objectProperty(source: string, name: string) {
  const file = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true)
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === name) {
      expression = node.initializer.getText(file)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(expression, `${name} is configured`).not.toBe('')
  return runInNewContext(`(${expression})`, { siteCopy })
}

describe('documentation layout polish', () => {
  it('lays tables out by the cell kinds the build assigns, never by column position', () => {
    const selectors: string[] = []
    css.walkRules((rule) => {
      if (/\btable\b|\bth\b|\btd\b|\btr\b|\bt(?:head|body)\b/.test(rule.selector)) {
        selectors.push(rule.selector)
      }
    })
    expect(selectors.length).toBeGreaterThan(5)
    expect(selectors.filter((selector) => /first-child|nth-|last-child/.test(selector))).toEqual([])
    expect(selectors.some((selector) => selector.includes('[data-cell="short"]'))).toBe(true)
    expect(selectors.some((selector) => selector.includes('[data-cell="code"]'))).toBe(true)
    expect(selectors.some((selector) => selector.includes('[data-cell="prose"]'))).toBe(true)
  })

  it('never wraps a header or a short label or identifier', () => {
    expect(declaration('.sl-markdown-content th', 'white-space', null)).toBe('nowrap')
    expect(declaration('.sl-markdown-content th', 'overflow-wrap', null)).toBe('normal')
    expect(declaration('.sl-markdown-content td[data-cell="short"]', 'white-space', null)).toBe(
      'nowrap',
    )
  })

  it('wraps code only at its build-time <wbr> points and prose only between words', () => {
    expect(declaration('.sl-markdown-content td code', 'overflow-wrap', null)).toBe('normal')
    expect(declaration('.sl-markdown-content td code', 'white-space', null)).toBeUndefined()
    expect(declaration('.sl-markdown-content td[data-cell="prose"]', 'overflow-wrap', null)).toBe(
      'break-word',
    )
    css.walkDecls('overflow-wrap', (decl) => {
      expect(decl.value, decl.parent?.toString()).not.toBe('anywhere')
    })
    css.walkDecls('word-break', (decl) => {
      expect(decl.value, decl.parent?.toString()).not.toBe('break-all')
    })
  })

  it('keeps long code and prose columns at readable minimum widths', () => {
    expect(declaration('.sl-markdown-content td[data-cell="code"]', 'min-width', null)).toBe(
      '11rem',
    )
    expect(declaration('.sl-markdown-content td[data-cell="prose"]', 'min-width', null)).toBe(
      '15rem',
    )
  })

  it('keeps tables within the content width and hints at remaining horizontal content', () => {
    expect(declaration('.sl-markdown-content table', 'display', null)).toBe('block')
    expect(declaration('.sl-markdown-content table', 'overflow-x', null)).toBe('auto')
    expect(declaration('.sl-markdown-content table', 'max-width', null)).toBe('100%')
    const background = declaration('.sl-markdown-content table', 'background', null) ?? ''
    expect(background.match(/\blocal\b/g)).toHaveLength(2)
    expect(background.match(/\bscroll\b/g)).toHaveLength(2)
    expect(background).toContain('to right')
    expect(background).toContain('to left')
    expect(background).toContain('var(--sl-color-bg)')
    expect(background).toContain('var(--sl-color-gray-5)')
    expect(declaration('.sl-markdown-content table', 'background-repeat', null)).toBe('no-repeat')
  })

  it('stacks each row as a labelled card when the content column is narrow', () => {
    expect(declaration('.sl-markdown-content', 'container', null)).toBe('docs / inline-size')
    expect(declaration('.sl-markdown-content table', 'overflow-x', cards)).toBe('visible')
    expect(declaration('.sl-markdown-content table', 'background', cards)).toBe('none')
    expect(declaration('.sl-markdown-content thead', 'display', cards)).toBe('none')
    for (const selector of [
      '.sl-markdown-content tbody',
      '.sl-markdown-content tr',
      '.sl-markdown-content td',
    ]) {
      expect(declaration(selector, 'display', cards)).toBe('block')
    }
    expect(declaration('.sl-markdown-content tr', 'border', cards)).toBe(
      '1px solid var(--sl-color-gray-5)',
    )
    expect(declaration('.sl-markdown-content td', 'min-width', cards)).toBe('0')
    expect(declaration('.sl-markdown-content td', 'padding', cards)).toBe('0')
    const label = '.sl-markdown-content td[data-label]::before'
    expect(declaration(label, 'content', cards)).toBe('attr(data-label)')
    expect(declaration(label, 'display', cards)).toBe('block')
    expect(declaration(label, 'color', cards)).toBe('var(--sl-color-gray-3)')
    expect(declaration(label, 'font-size', cards)).toBe('var(--sl-text-xs)')
  })

  it('registers the table classifier with the Sätteri Markdown processor', () => {
    const config = read('astro.config.ts')
    expect(config).toContain("import { satteri } from '@astrojs/markdown-satteri'")
    expect(config).toContain("import docsTablesPlugin from './src/docs-tables.ts'")
    expect(config).toMatch(
      /markdown: \{ processor: satteri\(\{ hastPlugins: \[docsTablesPlugin\(\)\] \}\) \}/,
    )
  })

  it('puts copy controls outside the code on narrow or touch screens', () => {
    const selector = '.expressive-code .frame > .copy'
    expect(declaration(selector, 'position')).toBe('static')
    expect(declaration(selector, 'justify-content')).toBe('flex-end')
    expect(declaration(selector, 'padding')).toBe('0.5rem')
    for (const rule of rules(selector)) {
      expect(rule.parent?.type).toBe('atrule')
      if (rule.parent?.type === 'atrule') {
        expect(rule.parent.name).toBe('media')
        expect(rule.parent.params).toBe('(max-width: 50rem), (hover: none)')
      }
    }
  })

  it.each(['bash', 'sh', 'shell', 'shellscript', 'zsh'])(
    'wraps %s blocks while preserving their indentation',
    (language) => {
      const options = objectProperty(read('astro.config.ts'), 'expressiveCode')
      const overrides = Object.entries(options.defaultProps.overridesByLang).find(([languages]) =>
        languages.split(',').includes(language),
      )
      expect(overrides?.[1]).toEqual({ wrap: true, preserveIndent: true })
    },
  )

  it('makes both table-of-contents layouts flow with short screens', () => {
    expect(declaration('mobile-starlight-toc nav', 'position')).toBe('static')
    expect(declaration('mobile-starlight-toc .dropdown', 'max-height')).toBe('none')
    expect(declaration('.main-frame', 'padding-top')).toBe('var(--sl-nav-height)')
    expect(declaration('.right-sidebar', 'position')).toBe('static')
    expect(declaration('.right-sidebar', 'height')).toBe('auto')
    expect(declaration('.right-sidebar', 'padding-top')).toBe('0')
    expect(declaration('.right-sidebar', 'overflow-y')).toBe('visible')
    for (const selector of [
      'mobile-starlight-toc nav',
      'mobile-starlight-toc .dropdown',
      '.main-frame',
      '.right-sidebar',
    ]) {
      for (const rule of rules(selector)) {
        expect(rule.parent?.type).toBe('atrule')
        if (rule.parent?.type === 'atrule') {
          expect(rule.parent.name).toBe('media')
          expect(rule.parent.params).toBe('screen and (max-height: 500px)')
        }
      }
    }
  })

  it('matches the marketing wordmark and title weight', () => {
    expect(declaration('.site-title', 'color')).toBe('var(--sl-color-white)')
    expect(declaration('.site-title', 'font-weight')).toBe('800')
    expect(declaration('h1#_top', 'font-weight')).toBe('800')
  })

  it('links Home and Pricing at the end of the documentation sidebar', () => {
    const sidebar = objectProperty(read('astro.config.ts'), 'sidebar')
    expect(sidebar.slice(-2)).toEqual([
      { label: siteCopy.en.home, link: '/' },
      { label: siteCopy.en.pricing, link: '/#pricing' },
    ])
  })

  it('links Home and Pricing in the documentation footer with comfortable tap targets', () => {
    const source = read('src/components/DocsFooter.astro')
    const document = new JSDOM(source.split('---').slice(2).join('---')).window.document
    const links = [...document.querySelectorAll('.site-links a')]
    expect(links.map((link) => link.getAttribute('href')).slice(0, 2)).toEqual(['/', '/#pricing'])
    expect(links[0]?.textContent).toContain('siteCopy.en.home')
    expect(links[1]?.textContent).toContain('siteCopy.en.pricing')
    const footerCss = postcss.parse(source.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '')
    const heights: string[] = []
    footerCss.walkRules('.site-links a', (rule) => {
      rule.walkDecls('min-height', (decl) => {
        heights.push(decl.value)
      })
    })
    expect(heights).toContain('2.75rem')
  })

  it.each([
    ['2026-10-18', 'October 18, 2026'],
    ['2026-01-01', 'January 1, 2026'],
    [undefined, undefined],
  ])('formats verified date %s using the legal pages date style', (lastVerified, expected) => {
    const source = read('src/components/DocsPageTitle.astro')
    const frontmatter = source.split('---')[1] ?? ''
    const file = ts.createSourceFile('title.ts', frontmatter, ts.ScriptTarget.Latest, true)
    let expression = ''
    file.forEachChild((node) => {
      if (!ts.isVariableStatement(node)) return
      for (const declaration of node.declarationList.declarations) {
        if (declaration.name.getText(file) === 'verifiedLabel') {
          expression = declaration.initializer?.getText(file) ?? ''
        }
      }
    })
    expect(runInNewContext(`(${expression})`, { lastVerified })).toBe(expected)
    expect(expression).toContain('timeZone:')
    expect(source).toContain('<time datetime={lastVerified}>{verifiedLabel}</time>')
    expect(source).toContain('class="last-verified"')
    expect(source).toContain('color: var(--sl-color-gray-3)')
  })

  it('limits every dark palette override to screen media so print stays light', () => {
    const darkRules = rules(':root:not([data-theme="light"])')
    for (const rule of darkRules) {
      expect(rule.parent?.type).toBe('atrule')
      if (rule.parent?.type === 'atrule') {
        expect(rule.parent.name).toBe('media')
        expect(rule.parent.params).toBe('screen')
      }
    }
  })
})
