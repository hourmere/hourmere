import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const root = process.env.HOURMERE_SITE_TEST_ROOT ?? fileURLToPath(new URL('../', import.meta.url))
const read = (file: string) => readFileSync(join(root, file), 'utf8')
const bookingUrl = 'https://app.hourmere.com/adrian-lee/30-minute-call'
const embedOrigin = 'https://app.hourmere.com'
const page = () =>
  new JSDOM(read('src/pages/embed-test/index.astro').replace(/^---[\s\S]*?---/, ''), {
    url: 'https://hourmere.com/embed-test/',
  })
const runPopupScript = (dom: JSDOM) => {
  runInNewContext(read('public/embed-test/popup.js'), {
    document: dom.window.document,
    window: dom.window,
  })
}

describe('unlisted booking widget test page', () => {
  it('labels manual device testing and asks crawlers not to index or follow', () => {
    const dom = page()
    try {
      const document = dom.window.document
      expect(document.querySelector('h1')?.textContent?.trim()).toBe(
        'Booking widget test page (unlisted)',
      )
      expect(document.body.textContent).toMatch(/manual device testing/i)
      expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
        'noindex,nofollow',
      )
      expect(document.querySelectorAll('section')).toHaveLength(2)
    } finally {
      dom.window.close()
    }
  })

  it('uses the documented declarative inline markup and one deferred hosted loader', () => {
    const dom = page()
    try {
      const document = dom.window.document
      const inline = document.querySelectorAll('[data-hourmere-inline]')
      expect(inline).toHaveLength(1)
      expect(inline[0]?.getAttribute('data-hourmere-url')).toBe(bookingUrl)
      expect(inline[0]?.getAttribute('data-hourmere-height')).toBe('720')
      const scripts = [...document.querySelectorAll('script')]
      expect(scripts.map((script) => script.getAttribute('src'))).toEqual([
        `${embedOrigin}/hourmere-embed.js`,
        '/embed-test/popup.js',
      ])
      for (const script of scripts) {
        expect(script.hasAttribute('defer')).toBe(true)
        expect(script.hasAttribute('is:inline')).toBe(true)
        expect(script.hasAttribute('async')).toBe(false)
        expect(script.textContent?.trim()).toBe('')
      }
    } finally {
      dom.window.close()
    }
  })

  it('opens the documented popup URL after the hosted widget loader runs', () => {
    const dom = page()
    try {
      const document = dom.window.document
      const button = document.querySelector<HTMLButtonElement>('#open-booking-popup')
      expect(button).not.toBeNull()
      expect(button?.type).toBe('button')
      expect(button?.disabled).toBe(true)
      const openPopup = vi.fn()
      Object.defineProperty(dom.window, 'Hourmere', { value: { openPopup } })
      runPopupScript(dom)
      expect(button?.disabled).toBe(false)
      button?.click()
      expect(openPopup).toHaveBeenCalledExactlyOnceWith({ url: bookingUrl })
    } finally {
      dom.window.close()
    }
  })

  it('keeps the popup unavailable and reports a failed widget load', () => {
    const dom = page()
    try {
      const document = dom.window.document
      const status = document.querySelector('#widget-status')
      const initialStatus = status?.textContent
      runPopupScript(dom)
      expect(document.querySelector<HTMLButtonElement>('#open-booking-popup')?.disabled).toBe(true)
      expect(status?.textContent?.trim()).not.toBe('')
      expect(status?.textContent).not.toBe(initialStatus)
    } finally {
      dom.window.close()
    }
  })

  it('excludes the test page and its aliases from the sitemap without excluding public pages', () => {
    const source = read('astro.config.ts')
    const file = ts.createSourceFile('astro.config.ts', source, ts.ScriptTarget.Latest, true)
    let expression = ''
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(file) === 'sitemap') {
        const options = node.arguments[0]
        if (options && ts.isObjectLiteralExpression(options)) {
          const filter = options.properties.find(
            (property) =>
              ts.isPropertyAssignment(property) && property.name.getText(file) === 'filter',
          )
          if (filter && ts.isPropertyAssignment(filter))
            expression = filter.initializer.getText(file)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    expect(expression).not.toBe('')
    const filter = runInNewContext(`(${expression})`, { URL }) as (page: string) => boolean
    for (const path of ['/embed-test', '/embed-test/', '/embed-test/index.html'])
      expect(filter(`https://hourmere.com${path}`), path).toBe(false)
    for (const path of ['/', '/docs/embedding', '/privacy', '/terms', '/embed-test-other'])
      expect(filter(`https://hourmere.com${path}`), path).toBe(true)
  })

  it('permits the hosted loader and frame only in exact test-page CSP rules', () => {
    const headers = read('public/_headers')
    const policies: { path: string; value: string }[] = []
    let path = ''
    for (const line of headers.split('\n')) {
      if (line.startsWith('/')) path = line.trim()
      const header = line.match(/^\s+Content-Security-Policy:\s*(.*)$/i)
      if (header) policies.push({ path, value: header[1] ?? '' })
    }
    expect(policies.map((policy) => policy.path).sort()).toEqual([
      '/embed-test',
      '/embed-test/',
      '/embed-test/index.html',
    ])
    for (const policy of policies) {
      const directives = Object.fromEntries(
        policy.value
          .split(';')
          .filter(Boolean)
          .map((value) => {
            const [name, ...sources] = value.trim().split(/\s+/)
            return [name, sources]
          }),
      )
      expect(directives, policy.path).toEqual({
        'default-src': ["'self'"],
        'script-src': ["'self'", embedOrigin],
        'frame-src': [embedOrigin],
        'style-src': ["'self'", "'unsafe-inline'"],
        'object-src': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
        'frame-ancestors': ["'none'"],
      })
    }
  })

  it('disallows the test route if the site publishes robots.txt', () => {
    const robots = join(root, 'public/robots.txt')
    if (existsSync(robots))
      expect(readFileSync(robots, 'utf8')).toMatch(/^Disallow:\s*\/embed-test\/?\s*$/im)
    const generatedRobots = readdirSync(join(root, 'src/pages'), {
      recursive: true,
      encoding: 'utf8',
    }).filter((file) => /(?:^|[/\\])robots\.txt(?:[/\\]index)?\.[^./\\]+$/.test(file))
    expect(
      generatedRobots,
      'A generated robots.txt route needs response coverage for Disallow: /embed-test.',
    ).toEqual([])
  })
})
