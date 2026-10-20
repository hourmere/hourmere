import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import postcss, { type AtRule, type Rule } from 'postcss'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const document = (path: string) =>
  new JSDOM(read(path).replace(/^---[\s\S]*?---/, '')).window.document
const styles = (path: string) => {
  const source = read(path)
  return postcss.parse(
    path.endsWith('.css') ? source : (source.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''),
  )
}
const rules = (path: string, selector: string, media?: string) => {
  const found: Rule[] = []
  styles(path).walkRules((rule) => {
    const parent = rule.parent
    const context = parent?.type === 'atrule' ? (parent as AtRule).params : undefined
    if (
      rule.selector
        .split(',')
        .map((part) => part.trim())
        .includes(selector) &&
      context === media
    ) {
      found.push(rule)
    }
  })
  return found
}
const declarations = (path: string, selector: string, media?: string) =>
  Object.fromEntries(
    rules(path, selector, media).flatMap((rule) =>
      rule.nodes.flatMap((node) => (node.type === 'decl' ? [[node.prop, node.value]] : [])),
    ),
  )
const css = './styles/global.css'
const header = './components/SiteHeader.astro'
const footer = './components/SiteFooter.astro'
const home = './pages/index.astro'
const legal = './layouts/Legal.astro'

const luminance = (hex: string) => {
  const channels =
    hex
      .slice(1)
      .match(/../g)
      ?.map((channel) => {
        const value = Number.parseInt(channel, 16) / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      }) ?? []
  return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722
}
const contrast = (first: string, second: string) => {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05)
}

describe('marketing navigation and layout polish', () => {
  it('offers documentation in the header, footer and 404 page', () => {
    for (const path of [header, footer, './pages/404.astro']) {
      expect(document(path).querySelector('a[href="/docs"]'), path).not.toBeNull()
    }
  })

  it('keeps Docs and Pricing outside the collapsed mobile section links', () => {
    const doc = document(header)
    for (const href of ['/docs', '/#pricing']) {
      const link = doc.querySelector(`a[href="${href}"]`)
      expect(link, href).not.toBeNull()
      expect(link?.closest('.section-link'), href).toBeNull()
    }
    expect(declarations(header, '.section-link', '(max-width: 760px)').display).toBe('none')
    expect(declarations(header, '.bar', '(max-width: 760px)')['flex-wrap']).toBe('wrap')
    expect(declarations(header, '.github span', '(max-width: 760px)').display).toBe('none')
    expect(doc.querySelector('.github')?.getAttribute('aria-label')).toBe('GitHub')
  })

  it('gives contact addresses a full row and a deliberate break after @', () => {
    const contact = document(footer).querySelector('.contact')
    expect(contact).not.toBeNull()
    expect(contact?.querySelectorAll('a[href^="{`mailto:"]')).toHaveLength(3)
    expect(contact?.querySelectorAll('wbr')).toHaveLength(3)
    expect(declarations(footer, '.contact')['grid-column']).toBe('1 / -1')
    expect(declarations(footer, 'li a')['overflow-wrap']).toBe('normal')
    for (const address of contact?.querySelectorAll('a') ?? []) {
      expect(address.innerHTML).toContain('@<wbr>')
    }
  })

  it('provides 44px footer link targets', () => {
    expect(declarations(footer, 'li a')).toMatchObject({
      display: 'inline-block',
      'min-height': '44px',
      'padding-block': '8px',
    })
  })

  it('caps the booking illustration and centers it in single-column layouts', () => {
    expect(declarations('./components/BookingPreview.astro', '.preview')).toMatchObject({
      width: '100%',
      'max-width': '440px',
      margin: '0 auto',
    })
  })

  it('lays out the four pricing plans in two or four columns', () => {
    const planRules = rules(home, '.grid.plans').concat(
      rules(home, '.grid.plans', '(min-width: 960px)'),
    )
    expect(planRules).toHaveLength(2)
    expect(declarations(home, '.grid.plans')['grid-template-columns']).toBe(
      'repeat(2, minmax(0, 1fr))',
    )
    expect(declarations(home, '.grid.plans', '(min-width: 960px)')['grid-template-columns']).toBe(
      'repeat(4, minmax(0, 1fr))',
    )
    expect(declarations(home, '.plan')).toMatchObject({ 'min-width': '0', padding: '16px' })
  })

  it('gives the desktop hero title more width and a conservative type cap', () => {
    expect(declarations(home, '.hero-grid', '(min-width: 960px)')['grid-template-columns']).toBe(
      '1.4fr 1fr',
    )
    expect(declarations(home, 'h1')['font-size']).toBe('clamp(36px, 6vw, 52px)')
  })

  it('keeps the optional wide-screen container at the reviewed 1120px cap', () => {
    expect(declarations(css, ':root')['--maxw']).toBe('1120px')
  })

  it('keeps dark-mode primary hover visible against its background', () => {
    const root = declarations(css, ':root')
    expect(declarations(css, '.btn-primary:hover')).toMatchObject({
      background: 'var(--button-hover-bg)',
      'border-color': 'var(--button-hover-border)',
    })
    for (const [selector, media] of [
      [':root:not([data-theme="light"])', '(prefers-color-scheme: dark)'],
      [':root[data-theme="dark"]', undefined],
    ] as const) {
      const dark = declarations(css, selector, media)
      expect(dark['--button-hover-bg']).toBe('var(--cobalt)')
      expect(dark['--button-hover-border']).toBe('#8faeff')
      expect(contrast(root['--cobalt'] ?? '', root['--button-text'] ?? '')).toBeGreaterThan(4.5)
      expect(contrast(dark['--button-hover-border'] ?? '', root['--ink'] ?? '')).toBeGreaterThan(3)
    }
  })
})

describe('legal navigation and print polish', () => {
  it('offers a return to contents after each privacy section', () => {
    const doc = document('./pages/privacy.astro')
    const headings = [...doc.querySelectorAll('h2[id]')].filter(
      (node) => node.id !== 'summary-title',
    )
    expect(headings).toHaveLength(17)
    expect(doc.querySelectorAll('.back-to-contents a[href="#contents"]')).toHaveLength(
      headings.length,
    )
    for (const heading of headings) {
      let sibling = heading.nextElementSibling
      let hasReturnLink = false
      while (sibling && sibling.tagName !== 'H2') {
        if (sibling.matches('.back-to-contents')) hasReturnLink = true
        sibling = sibling.nextElementSibling
      }
      expect(hasReturnLink, heading.id).toBe(true)
    }
    expect(document(legal).querySelector('nav#contents.toc')).not.toBeNull()
    expect(declarations(legal, '.prose :global(.back-to-contents a)')['min-height']).toBe('44px')
  })

  it('uses the light palette for print even with a stored dark theme', () => {
    for (const selector of [':root', ':root[data-theme]', ':root:not([data-theme="light"])']) {
      expect(declarations(css, selector, 'print')).toMatchObject({
        '--bg': '#ffffff',
        '--surface': '#ffffff',
        '--text': 'var(--ink)',
        '--link': 'var(--cobalt)',
        'color-scheme': 'light',
      })
    }
  })

  it('prints legal content without site chrome or repeated navigation', () => {
    for (const selector of [
      ':global(.site-header)',
      ':global(.site-footer)',
      ':global(.skip-link)',
      '.toc',
      '.prose :global(.back-to-contents)',
    ]) {
      expect(declarations(legal, selector, 'print').display, selector).toBe('none')
    }
    expect(declarations(legal, '.container.legal', 'print')).toMatchObject({
      'max-width': 'none',
      padding: '0',
    })
  })

  it('shows the destination of external legal links on paper', () => {
    expect(declarations(legal, '.prose :global(a[href^="http"])::after', 'print')).toMatchObject({
      content: '" (" attr(href) ")"',
      'overflow-wrap': 'anywhere',
    })
  })
})
