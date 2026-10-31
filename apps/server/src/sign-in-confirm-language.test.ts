import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { LANGUAGE_COOKIE } from '@hourmere/core/language'
import { Hono } from 'hono'
import { type DefaultTreeAdapterTypes, parse } from 'parse5'
import { describe, expect, it } from 'vitest'
import { MAGIC_LINK_CONFIRM_PATH, signInConfirmPage } from './sign-in-confirm.ts'
import { inlineAsset, pressConfirmButton } from './sign-in-confirm-testing.ts'

const app = new Hono().get(MAGIC_LINK_CONFIRM_PATH, signInConfirmPage)
const content = async (headers: Record<string, string> = {}) => {
  const response = await app.request(MAGIC_LINK_CONFIRM_PATH, { headers })
  return { response, html: await response.text() }
}

it.each<Record<string, string>>([
  { 'accept-language': 'de-AT,en;q=0.5' },
  { cookie: 'hourmere-language=de' },
])('keeps public-only languages out of the sign-in interface: %j', async (headers) => {
  const { html } = await content(headers)
  expect(html).toContain('<html lang="en">')
  expect(html).not.toContain('id="language-option-de"')
  expect(inlineAsset(html, 'script')).not.toContain('"de":')
})

interface Event {
  target: Element
  key?: string
  shiftKey?: boolean
  preventDefault(): void
}

interface Element {
  hidden: boolean
  textContent: string
  attributes: Record<string, string>
  events: Record<string, (event: Event) => void>
  children: Element[]
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  addEventListener(name: string, listener: (event: Event) => void): void
  querySelector(selector: string): Element | undefined
  querySelectorAll(selector: string): Element[]
  contains(target: Element): boolean
  focus(): void
  append(input: { type?: string; name?: string; value?: string }): void
}

function browser(html: string, fragment: string, storageBlocked = false, protocol = 'https:') {
  const elements = new Map<string, Element>()
  const inputs: { type?: string; name?: string; value?: string }[] = []
  let activeElement: Element | undefined
  const documentEvents: Record<string, (event: Event) => void> = {}
  const buildElement = (node: DefaultTreeAdapterTypes.Element): Element => {
    const attributes = Object.fromEntries(node.attrs.map(({ name, value }) => [name, value]))
    const descendants = (element: Element): Element[] =>
      element.children.flatMap((child) => [child, ...descendants(child)])
    const element: Element = {
      hidden: Object.hasOwn(attributes, 'hidden'),
      textContent: node.childNodes.map((child) => ('value' in child ? child.value : '')).join(''),
      attributes,
      events: {},
      children: node.childNodes
        .filter((child): child is DefaultTreeAdapterTypes.Element => 'tagName' in child)
        .map(buildElement),
      getAttribute(name) {
        return this.attributes[name] ?? null
      },
      setAttribute(name, value) {
        this.attributes[name] = value
      },
      addEventListener(name, listener) {
        this.events[name] = listener
      },
      querySelector(selector) {
        return this.querySelectorAll(selector)[0]
      },
      querySelectorAll(selector) {
        if (selector === '[role="menuitemradio"]')
          return descendants(this).filter((child) => child.attributes.role === 'menuitemradio')
        if (selector === '[data-language-check]')
          return descendants(this).filter((child) =>
            Object.hasOwn(child.attributes, 'data-language-check'),
          )
        throw new Error(`Unexpected element selector: ${selector}`)
      },
      contains(target) {
        return this === target || descendants(this).includes(target)
      },
      focus() {
        activeElement = this
        documentEvents.focusin?.({ target: this, preventDefault() {} })
      },
      append(input) {
        inputs.push(input)
      },
    }
    if (attributes.id) elements.set(attributes.id, element)
    if (node.tagName === 'button' && attributes.type === 'submit') elements.set('submit', element)
    return element
  }
  for (const child of parse(html).childNodes) if ('tagName' in child) buildElement(child)
  // With scripting enabled, <noscript> contains raw text, not a live child element.
  expect(elements.has('javascript-note')).toBe(false)
  const submit = elements.get('submit')
  if (!submit) throw new Error('No submit button')
  const stored: [string, string][] = []
  const cookies: string[] = []
  const location = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === 'hash') return fragment
        if (key === 'protocol') return protocol
        throw new Error(`Unexpected location read: ${String(key)}`)
      },
      set() {
        throw new Error('Language change attempted navigation')
      },
    },
  )
  const document = {
    documentElement: { lang: /<html lang="([^"]+)"/.exec(html)?.[1] ?? '' },
    title: /<title>([^<]+)<\/title>/.exec(html)?.[1] ?? '',
    getElementById: (id: string) => elements.get(id) ?? null,
    get activeElement() {
      return activeElement
    },
    addEventListener(name: string, listener: (event: Event) => void) {
      documentEvents[name] = listener
    },
    querySelector: (selector: string) => {
      if (selector !== '#confirm button[type="submit"]') throw new Error('Unexpected selector')
      return submit
    },
    createElement: () => ({}),
  }
  Object.defineProperty(document, 'cookie', {
    set(value: string) {
      if (storageBlocked) throw new Error('Cookie storage refused')
      cookies.push(value)
    },
    get() {
      throw new Error('The inline script must not read cookie contents')
    },
  })
  const context = {
    URLSearchParams,
    String,
    document,
    location,
    localStorage: {
      setItem(key: string, value: string) {
        if (storageBlocked) throw new Error('Local storage refused')
        stored.push([key, value])
      },
    },
  }
  const script = inlineAsset(html, 'script')
  runInNewContext(script, context)
  return {
    document,
    elements,
    submit,
    inputs,
    stored,
    cookies,
    switchTo(value: string) {
      runInNewContext(`setLanguage(${JSON.stringify(value)})`, context)
    },
    select(language: 'en' | 'zh-CN') {
      const option = elements.get(`language-option-${language}`)
      const listener = option?.events.click
      if (!option || !listener) throw new Error('Language option is not wired')
      listener({ target: option, preventDefault() {} })
    },
    click(id: string) {
      const element = elements.get(id)
      if (!element?.events.click) throw new Error(`No click listener on ${id}`)
      element.events.click({ target: element, preventDefault() {} })
    },
    key(id: string, key: string, shiftKey = false) {
      const element = elements.get(id)
      if (!element?.events.keydown) throw new Error(`No key listener on ${id}`)
      let prevented = false
      element.events.keydown({
        target: element,
        key,
        shiftKey,
        preventDefault() {
          prevented = true
        },
      })
      return prevented
    },
    outsidePointer() {
      const listener = documentEvents.pointerdown
      if (!listener) throw new Error('Outside pointer listener is not wired')
      listener({ target: submit, preventDefault() {} })
    },
  }
}

describe('server-rendered sign-in confirmation languages', () => {
  it.each([
    [{}, 'en'],
    [{ 'Accept-Language': 'zh-CN, en;q=0.8' }, 'zh-CN'],
    [{ 'Accept-Language': 'en;q=0.2, zh-CN;q=0.9' }, 'zh-CN'],
    [{ 'Accept-Language': 'zh-CN;q=0, en;q=0.1' }, 'en'],
    [{ 'Accept-Language': 'zh-TW' }, 'en'],
    [{ Cookie: `${LANGUAGE_COOKIE}=de`, 'Accept-Language': 'zh-CN' }, 'zh-CN'],
    [{ Cookie: `${LANGUAGE_COOKIE}=de`, 'Accept-Language': 'de-CH' }, 'en'],
    [{ Cookie: `${LANGUAGE_COOKIE}=de`, 'Accept-Language': 'de-CH,zh-CN;q=0.8,en;q=0.5' }, 'zh-CN'],
    [{ Cookie: `${LANGUAGE_COOKIE}=de`, 'Accept-Language': 'en;q=0.2,zh-CN;q=0.9' }, 'zh-CN'],
    [{ Cookie: `${LANGUAGE_COOKIE}=de`, 'Accept-Language': 'zh-CN;q=0.2,en;q=0.9' }, 'en'],
    [{ Cookie: `${LANGUAGE_COOKIE}=de`, 'Accept-Language': 'zh-CN;q=0,en;q=0.1' }, 'en'],
    [{ Cookie: `${LANGUAGE_COOKIE}=en`, 'Accept-Language': 'zh-CN' }, 'en'],
    [{ Cookie: `${LANGUAGE_COOKIE}=zh-CN`, 'Accept-Language': 'en' }, 'zh-CN'],
    [{ Cookie: `${LANGUAGE_COOKIE}=__proto__`, 'Accept-Language': 'zh-CN' }, 'zh-CN'],
  ] as const)('renders the preferred supported language for %j', async (headers, language) => {
    const { response, html } = await content(headers)
    expect(response.status).toBe(200)
    expect(html).toContain(`<html lang="${language}">`)
    expect(html).toContain(
      `<button type="submit">${language === 'en' ? 'Sign in to Hourmere' : '登录 Hourmere'}</button>`,
    )
    expect(response.headers.getSetCookie()).toEqual([])
    expect(html).not.toContain('__proto__')
  })

  it.each(['en', 'zh-CN'])(
    'has exact hashes, self-contained assets and private headers in %s',
    async (language) => {
      const { response, html } = await content({ Cookie: `${LANGUAGE_COOKIE}=${language}` })
      const hash = (source = '') =>
        `'sha256-${createHash('sha256').update(source).digest('base64')}'`
      const script = inlineAsset(html, 'script')
      const style = inlineAsset(html, 'style')
      expect(response.headers.get('Content-Security-Policy')?.split('; ')).toEqual([
        "default-src 'none'",
        `script-src ${hash(script)}`,
        `style-src ${hash(style)}`,
        "form-action 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ])
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
      expect(response.headers.get('Vary')).toBe('Accept-Language, Cookie')
      expect(html).not.toMatch(/\s(src|href)=/)
      const head = await app.request(MAGIC_LINK_CONFIRM_PATH, { method: 'HEAD' })
      expect(await head.text()).toBe('')
    },
  )

  it('switches labels and accessibility in place while retaining exactly the original form parameters', async () => {
    const { html } = await content()
    const fragment =
      '#token=synthetic-capability&callbackURL=%2Fapp%3Ftab%3D2&errorCallbackURL=%2Fsign-in&untrusted=ignored'
    const view = browser(html, fragment)
    const original = JSON.stringify(view.inputs)
    expect(view.elements.get('confirm')?.hidden).toBe(false)
    expect(view.elements.get('incomplete')?.hidden).toBe(true)
    expect(view.cookies).toEqual([])
    expect(view.stored).toEqual([])
    expect(view.elements.get('language-trigger')?.events.click).toBeTypeOf('function')
    view.select('zh-CN')
    expect(view.document.documentElement.lang).toBe('zh-CN')
    expect(view.document.title).toBe('登录 Hourmere')
    expect(view.submit.textContent).toBe('登录 Hourmere')
    expect(view.elements.get('incomplete')?.textContent).toContain('链接不完整')
    expect(view.elements.get('language-trigger')?.attributes['aria-label']).toBe('语言：简体中文')
    expect(view.elements.get('language-current')?.textContent).toBe('简体中文')
    expect(view.elements.get('language-current')?.attributes.lang).toBe('zh-CN')
    expect(view.elements.get('language-option-zh-CN')?.attributes['aria-checked']).toBe('true')
    expect(view.elements.get('language-option-en')?.attributes['aria-checked']).toBe('false')
    expect(
      view.elements.get('language-option-zh-CN')?.querySelector('[data-language-check]')
        ?.textContent,
    ).toBe('✓')
    expect(
      view.elements.get('language-option-en')?.querySelector('[data-language-check]')?.textContent,
    ).toBe('')
    expect(view.stored).toEqual([[LANGUAGE_COOKIE, 'zh-CN']])
    expect(view.cookies).toEqual([
      `${LANGUAGE_COOKIE}=zh-CN; Path=/; SameSite=Lax; Max-Age=31536000; Secure`,
    ])
    view.select('en')
    expect(view.document.documentElement.lang).toBe('en')
    expect(view.submit.textContent).toBe('Sign in to Hourmere')
    expect(view.elements.get('language-trigger')?.attributes['aria-label']).toBe(
      'Language: English',
    )
    expect(JSON.stringify(view.inputs)).toBe(original)
    expect(view.inputs.map((input) => input.name)).not.toContain('untrusted')
    expect(JSON.stringify([view.stored, view.cookies])).not.toContain('synthetic-capability')
    expect(view.elements.get('confirm')?.hidden).toBe(false)
    expect(view.elements.get('incomplete')?.hidden).toBe(true)
  })

  it.each(['en', 'zh-CN'] as const)(
    'opens to the current %s option, navigates, closes and restores focus',
    async (language) => {
      const { html } = await content({ Cookie: `${LANGUAGE_COOKIE}=${language}` })
      const view = browser(html, '#token=synthetic')
      const trigger = view.elements.get('language-trigger')
      const menu = view.elements.get('language-menu')
      const current = view.elements.get(`language-option-${language}`)
      expect(trigger?.attributes).toMatchObject({
        type: 'button',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        'aria-controls': 'language-menu',
      })
      expect(menu?.hidden).toBe(true)
      view.click('language-trigger')
      expect(menu?.hidden).toBe(false)
      expect(trigger?.attributes['aria-expanded']).toBe('true')
      expect(view.document.activeElement).toBe(current)
      expect(view.key('language-menu', 'Home')).toBe(true)
      expect(view.document.activeElement).toBe(view.elements.get('language-option-en'))
      expect(view.key('language-menu', 'ArrowUp')).toBe(true)
      expect(view.document.activeElement).toBe(view.elements.get('language-option-zh-CN'))
      expect(view.key('language-menu', 'ArrowDown')).toBe(true)
      expect(view.document.activeElement).toBe(view.elements.get('language-option-en'))
      expect(view.key('language-menu', 'End')).toBe(true)
      expect(view.document.activeElement).toBe(view.elements.get('language-option-zh-CN'))
      expect(view.key('language-menu', 'Escape')).toBe(true)
      expect(menu?.hidden).toBe(true)
      expect(trigger?.attributes['aria-expanded']).toBe('false')
      expect(view.document.activeElement).toBe(trigger)
      expect(view.cookies).toEqual([])
      expect(view.stored).toEqual([])
      view.key('language-trigger', 'ArrowDown')
      expect(menu?.hidden).toBe(false)
      expect(view.document.activeElement).toBe(current)
      expect(view.key('language-menu', 'End')).toBe(true)
      expect(view.key('language-menu', 'Tab', true)).toBe(true)
      expect(menu?.hidden).toBe(true)
      expect(trigger?.attributes['aria-expanded']).toBe('false')
      expect(view.document.activeElement).toBe(trigger)
      view.key('language-trigger', 'ArrowDown')
      expect(menu?.hidden).toBe(false)
      expect(view.document.activeElement).toBe(current)
      view.select(language === 'en' ? 'zh-CN' : 'en')
      expect(menu?.hidden).toBe(true)
      expect(view.document.activeElement).toBe(trigger)
      view.click('language-trigger')
      view.outsidePointer()
      expect(menu?.hidden).toBe(true)
      view.click('language-trigger')
      view.submit.focus()
      expect(menu?.hidden).toBe(true)
      expect(view.document.activeElement).toBe(view.submit)
    },
  )

  it('supports incomplete links and refused preference storage without showing a sign-in button', async () => {
    const { html } = await content()
    const view = browser(html, '#callbackURL=%2F', true)
    expect(view.elements.get('confirm')?.hidden).toBe(true)
    expect(view.elements.get('incomplete')?.hidden).toBe(false)
    expect(() => view.select('zh-CN')).not.toThrow()
    expect(view.document.title).toBe('登录 Hourmere')
    expect(view.elements.get('incomplete')?.textContent).toContain('链接不完整')
    expect(view.elements.get('confirm')?.hidden).toBe(true)
    expect(view.inputs).toEqual([])
    expect(view.cookies).toEqual([])
    expect(view.stored).toEqual([])
    expect(() => view.switchTo('__proto__')).not.toThrow()
    expect(view.document.title).toBe('登录 Hourmere')
  })

  it('keeps the existing strict fragment-only and explicit-submit harness valid', async () => {
    const link = new URL(
      'https://hourmere.example/sign-in/confirm#token=synthetic&callbackURL=%2Fapp&errorCallbackURL=%2Fsign-in',
    )
    const submitted = await pressConfirmButton(app, link)
    expect(submitted.origin).toBe(link.origin)
    expect(submitted.pathname).toBe('/api/auth/magic-link/verify')
    expect(Object.fromEntries(submitted.searchParams)).toEqual({
      token: 'synthetic',
      callbackURL: '/app',
      errorCallbackURL: '/sign-in',
    })
  })
})

it('negotiates the next supported sign-in language after a public-only preference', async () => {
  const { html } = await content({ 'accept-language': 'de-CH,zh-CN;q=0.8,en;q=0.5' })
  expect(html).toContain('<html lang="zh-CN">')
  expect(html).not.toContain('id="language-option-de"')
})
