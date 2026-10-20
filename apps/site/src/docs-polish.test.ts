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

function rules(selector: string) {
  const matches: Rule[] = []
  css.walkRules((rule) => {
    if (rule.selectors.includes(selector)) matches.push(rule)
  })
  expect(matches.length, `${selector} has an override`).toBeGreaterThan(0)
  return matches
}

function declaration(selector: string, property: string) {
  const values: string[] = []
  for (const rule of rules(selector)) {
    rule.walkDecls(property, (decl) => {
      values.push(decl.value)
    })
  }
  return values.at(-1)
}

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
  it.each([
    '.sl-markdown-content td:not(:first-child)',
    '.sl-markdown-content td:not(:first-child) code',
  ])('allows long table values to wrap in %s', (selector) => {
    expect(declaration(selector, 'overflow-wrap')).toBe('anywhere')
    expect(declaration(selector, 'white-space')).toBe('normal')
  })

  it.each([
    '.sl-markdown-content th',
    '.sl-markdown-content td:first-child',
    '.sl-markdown-content td:first-child code',
  ])('preserves word boundaries in %s', (selector) => {
    expect(declaration(selector, 'overflow-wrap')).toBe('normal')
    expect(declaration(selector, 'word-break')).toBe('keep-all')
  })

  it.each(['.sl-markdown-content th', '.sl-markdown-content td:first-child code'])(
    'keeps %s intact within the scrollable table',
    (selector) => {
      expect(declaration(selector, 'white-space')).toBe('nowrap')
    },
  )

  it('gives the identifier column readable space', () => {
    expect(declaration('.sl-markdown-content td:first-child', 'min-width')).toBe('12rem')
  })

  it('keeps tables within the content width and hints at remaining horizontal content', () => {
    expect(declaration('.sl-markdown-content table', 'display')).toBe('block')
    expect(declaration('.sl-markdown-content table', 'overflow-x')).toBe('auto')
    expect(declaration('.sl-markdown-content table', 'max-width')).toBe('100%')
    const background = declaration('.sl-markdown-content table', 'background') ?? ''
    expect(background.match(/\blocal\b/g)).toHaveLength(2)
    expect(background.match(/\bscroll\b/g)).toHaveLength(2)
    expect(background).toContain('to right')
    expect(background).toContain('to left')
    expect(background).toContain('var(--sl-color-bg)')
    expect(background).toContain('var(--sl-color-gray-5)')
    expect(declaration('.sl-markdown-content table', 'background-repeat')).toBe('no-repeat')
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
