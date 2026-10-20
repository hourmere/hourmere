import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { LANGUAGE_COOKIE } from '@hourmere/core/language'
import { Hono } from 'hono'
import { type DefaultTreeAdapterTypes, parse } from 'parse5'
import { describe, expect, it } from 'vitest'
import { MAGIC_LINK_CONFIRM_PATH, signInConfirmPage } from './sign-in-confirm.ts'
import { inlineAsset } from './sign-in-confirm-testing.ts'

type Element = DefaultTreeAdapterTypes.Element
const app = new Hono().get(MAGIC_LINK_CONFIRM_PATH, signInConfirmPage)
const webStyle = readFileSync(new URL('../../web/src/styles.css', import.meta.url), 'utf8')
const webMark = readFileSync(
  new URL('../../web/src/assets/hourmere-mark.svg', import.meta.url),
  'utf8',
)
const languages = [
  ['en', 'Sign in to Hourmere', 'Interface language'],
  ['zh-CN', '登录 Hourmere', '界面语言'],
] as const

function elements(html: string): Element[] {
  const found: Element[] = []
  const visit = (node: DefaultTreeAdapterTypes.Node) => {
    if ('tagName' in node) found.push(node)
    if ('childNodes' in node) for (const child of node.childNodes) visit(child)
  }
  visit(parse(html))
  return found
}

const attribute = (element: Element | undefined, name: string) =>
  element?.attrs.find((attribute) => attribute.name === name)?.value
const hasClass = (element: Element, name: string) =>
  attribute(element, 'class')?.split(/\s+/).includes(name)
const text = (element: Element | undefined): string =>
  element?.childNodes
    .map((child) => ('value' in child ? child.value : 'tagName' in child ? text(child) : ''))
    .join('') ?? ''

// These are static declarations from this small self-contained stylesheet. Restrict each
// lookup to one rule so a token or property elsewhere cannot make an assertion pass.
function declarations(style: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const source = style.replace(/\/\*[\s\S]*?\*\//g, '')
  const body = new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^}]+)\\}`).exec(source)?.[1]
  expect(body, `Missing CSS rule: ${selector}`).toBeDefined()
  return Object.fromEntries(
    (body ?? '')
      .split(';')
      .map((declaration) => {
        const colon = declaration.indexOf(':')
        return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()]
      })
      .filter(([name]) => name),
  )
}

function mediaBlock(style: string, condition: string): string {
  const start = style.indexOf(`@media (${condition})`)
  expect(start, `Missing CSS media condition: ${condition}`).toBeGreaterThanOrEqual(0)
  const open = style.indexOf('{', start)
  let depth = 1
  let end = open + 1
  while (depth && end < style.length) {
    if (style[end] === '{') depth++
    if (style[end] === '}') depth--
    end++
  }
  return style.slice(open + 1, end - 1)
}

function theme(style: string, dark: boolean): Record<string, string> {
  const light = declarations(style, ':root')
  if (!dark) return light
  const media = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*)/.exec(style)?.[1]
  expect(media, 'Missing system dark theme').toBeDefined()
  return { ...light, ...declarations(media ?? '', ':root') }
}

function resolve(value: string | undefined, tokens: Record<string, string>): string {
  expect(value, 'Missing CSS declaration').toBeDefined()
  return (value ?? '').replace(/var\((--[\w-]+)\)/g, (_, token: string) =>
    resolve(tokens[token], tokens),
  )
}

async function content(language: string) {
  const response = await app.request(MAGIC_LINK_CONFIRM_PATH, {
    headers: { Cookie: `${LANGUAGE_COOKIE}=${language}` },
  })
  const html = await response.text()
  return { response, html, nodes: elements(html), style: inlineAsset(html, 'style') }
}

describe('branded sign-in confirmation appearance', () => {
  it.each(languages)(
    'renders the sign-in card and controls in %s',
    async (language, title, label) => {
      const { nodes } = await content(language)
      const main = nodes.find((element) => element.tagName === 'main')
      const card = nodes.find((element) => hasClass(element, 'card'))
      const logo = nodes.find((element) => hasClass(element, 'logo'))
      const word = nodes.find((element) => hasClass(element, 'logo-word'))
      const heading = nodes.find((element) => attribute(element, 'id') === 'page-title')
      const header = nodes.find((element) => hasClass(element, 'card-header'))
      const picker = nodes.find((element) => hasClass(element, 'language-picker'))
      const controls = nodes.find((element) => attribute(element, 'id') === 'language-select')
      const form = nodes.find((element) => attribute(element, 'id') === 'confirm')
      expect(main && hasClass(main, 'centered')).toBe(true)
      expect(card?.parentNode).toBe(main)
      expect(header?.tagName).toBe('header')
      expect(header?.parentNode).toBe(card)
      expect(logo?.parentNode).toBe(header)
      expect(text(word)).toBe('Hourmere')
      expect(word?.parentNode).toBe(logo)
      expect(heading?.parentNode).toBe(card)
      expect(text(heading)).toBe(title)
      expect(picker?.parentNode).toBe(header)
      expect(picker?.tagName).toBe('label')
      expect(controls?.parentNode).toBe(picker)
      expect(controls?.tagName).toBe('select')
      expect(attribute(controls, 'aria-label')).toBe(label)
      const options = nodes.filter(
        (element) => element.tagName === 'option' && element.parentNode === controls,
      )
      expect(options).toHaveLength(2)
      for (const option of options) {
        expect(attribute(option, 'value')).toBe(attribute(option, 'lang'))
        expect(attribute(option, 'selected')).toBe(
          attribute(option, 'lang') === language ? '' : undefined,
        )
      }
      expect(attribute(form, 'method')).toBe('get')
      expect(attribute(form, 'action')).toBe('/api/auth/magic-link/verify')
      expect(attribute(form, 'hidden')).toBe('')
      const submit = nodes.find(
        (element) => element.tagName === 'button' && attribute(element, 'type') === 'submit',
      )
      expect(text(submit)).toBe(title)
      expect(nodes.indexOf(logo as Element)).toBeLessThan(nodes.indexOf(heading as Element))
    },
  )

  it.each(languages)(
    'uses app layout, button states and keyboard focus styles in %s',
    async (language) => {
      const { style } = await content(language)
      const tokens = theme(style, false)
      expect(declarations(style, '.centered')).toMatchObject({
        display: 'grid',
        'place-items': 'center',
        'min-height': '100svh',
      })
      expect(resolve(declarations(style, '.centered').padding, tokens)).toBe('24px 16px')
      const card = declarations(style, '.card')
      expect(card).toMatchObject({ width: '100%', 'max-width': '420px' })
      expect(resolve(card.padding, tokens)).toBe('32px 24px')
      expect(resolve(card['border-radius'], tokens)).toBe('10px')
      expect(declarations(style, 'button, select')).toMatchObject({
        'min-height': '42px',
        font: 'inherit',
        'font-size': 'max(16px, 1rem)',
      })
      const submit = declarations(style, '#confirm button[type="submit"]')
      expect(submit.width).toBe('100%')
      expect(resolve(submit.background, tokens)).toBe(resolve(tokens['--accent'], tokens))
      expect(resolve(submit.color, tokens)).toBe('#ffffff')
      expect(
        resolve(declarations(style, '#confirm button[type="submit"]:hover').background, tokens),
      ).toBe(resolve(tokens['--accent-hover'], tokens))
      const focus = declarations(style, ':focus-visible')
      expect(resolve(focus.outline, tokens)).toBe(`3px solid ${resolve(tokens['--focus'], tokens)}`)
      expect(focus['outline-offset']).toBe('2px')
      expect(declarations(style, '[hidden]').display).toBe('none !important')
    },
  )

  it('keeps a compact wrapping header and mobile controls without sticky touch hover', async () => {
    const { style } = await content('en')
    expect(declarations(style, '.card-header')).toMatchObject({
      display: 'flex',
      'align-items': 'center',
      'justify-content': 'space-between',
      'flex-wrap': 'wrap',
      gap: 'var(--space-3)',
    })
    expect(declarations(style, '.card')['min-width']).toBe('0')
    expect(declarations(style, '.centered')['min-width']).toBe('0')
    expect(style).toMatch(/min-height:\s*100vh;\s*min-height:\s*100svh;/)
    expect(declarations(style, 'body')['font-size']).toBe('1rem')
    expect(declarations(style, '.language-picker span')).toMatchObject({
      position: 'absolute',
      'clip-path': 'inset(50%)',
    })
    expect(declarations(mediaBlock(style, 'pointer: coarse'), 'button, select')).toMatchObject({
      'min-height': '44px',
    })
    const hover = mediaBlock(style, 'hover: hover')
    expect(declarations(hover, 'button:hover').background).toBe('var(--accent-soft)')
    expect(declarations(hover, '#confirm button[type="submit"]:hover').background).toBe(
      'var(--accent-hover)',
    )
    expect(style.replace(hover, '')).not.toContain(':hover')
  })

  it.each(languages)('matches app light and dark design tokens in %s', async (language) => {
    const { style } = await content(language)
    expect(style).not.toMatch(/\b(?:Canvas|CanvasText|GrayText)\b/)
    for (const dark of [false, true]) {
      const tokens = theme(style, dark)
      const appTokens = theme(webStyle, dark)
      for (const name of [
        '--bg',
        '--surface',
        '--text',
        '--muted',
        '--border',
        '--border-strong',
        '--accent',
        '--accent-hover',
        '--accent-text',
        '--accent-soft',
        '--accent-soft-text',
        '--focus',
        '--shadow',
      ]) {
        expect(
          resolve(tokens[name], tokens),
          `${language} ${dark ? 'dark' : 'light'} ${name}`,
        ).toBe(resolve(appTokens[name], appTokens))
      }
      expect(tokens['color-scheme']).toBe(dark ? 'dark' : 'light')
      const body = declarations(style, 'body')
      expect(resolve(body.background, tokens)).toBe(resolve(appTokens['--bg'], appTokens))
      expect(resolve(body.color, tokens)).toBe(resolve(appTokens['--text'], appTokens))
      expect(resolve(declarations(style, '.card').background, tokens)).toBe(
        resolve(appTokens['--surface'], appTokens),
      )
    }
  })

  it.each(languages)('uses a local CJK font stack ahead of system-ui in %s', async (language) => {
    const { style } = await content(language)
    const stack = declarations(style, ':lang(zh)')
      ['font-family']?.split(',')
      .map((font) => font.trim().replace(/^['"]|['"]$/g, ''))
    expect(stack?.slice(0, 4)).toEqual([
      'PingFang SC',
      'Microsoft YaHei',
      'Noto Sans CJK SC',
      'system-ui',
    ])
    expect(style).not.toMatch(/@(?:import|font-face)\b/i)
  })

  it.each(languages)(
    'inlines the existing logo geometry with valid CSP hashes in %s',
    async (language) => {
      const { response, html, nodes, style } = await content(language)
      const svg = nodes.filter((element) => element.tagName === 'svg')
      expect(svg).toHaveLength(1)
      expect(attribute(svg[0], 'viewBox')).toBe('0 0 100 100')
      expect(attribute(svg[0], 'width')).toBe('32')
      expect(attribute(svg[0], 'height')).toBe('32')
      expect(attribute(svg[0], 'aria-hidden')).toBe('true')
      expect(attribute(svg[0], 'focusable')).toBe('false')
      const geometry = (source: Element[]) =>
        source
          .filter((element) => ['circle', 'path'].includes(element.tagName))
          .map((element) => ({
            tag: element.tagName,
            attributes: element.attrs.filter(({ name }) =>
              ['cx', 'cy', 'r', 'd', 'stroke-width', 'stroke-linecap'].includes(name),
            ),
          }))
      expect(geometry(nodes)).toEqual(geometry(elements(webMark)))
      const clip = nodes.find((element) => element.tagName === 'clipPath')
      const wave = nodes.find((element) => attribute(element, 'clip-path'))
      expect(attribute(clip, 'id')).toBeTruthy()
      expect(attribute(wave, 'clip-path')).toBe(`url(#${attribute(clip, 'id')})`)
      expect(attribute(wave, 'fill')).toBe('currentColor')
      const ring = nodes.find(
        (element) => element.tagName === 'circle' && attribute(element, 'r') === '32',
      )
      expect(attribute(ring, 'stroke')).toBe('currentColor')
      const hand = nodes.find((element) => attribute(element, 'd') === 'M50 46 L50 31')
      expect(attribute(hand, 'stroke')).toBe('currentColor')
      const amberHand = nodes.find((element) => attribute(element, 'd') === 'M50 46 L62 39')
      expect(attribute(amberHand, 'stroke')?.toLowerCase()).toBe('#f2a33a')
      for (const dark of [false, true]) {
        const tokens = theme(style, dark)
        expect(resolve(declarations(style, '.logo svg').color, tokens)).toBe(
          dark ? '#ffffff' : '#1f4fd8',
        )
      }
      const hash = (source: string) =>
        `'sha256-${createHash('sha256').update(source).digest('base64')}'`
      const policy = response.headers.get('Content-Security-Policy')?.split('; ')
      expect(policy).toContain(`style-src ${hash(style)}`)
      expect(policy).toContain(`script-src ${hash(inlineAsset(html, 'script'))}`)
      expect(policy).toContain("default-src 'none'")
      expect(policy).toContain("form-action 'self'")
      expect(html).not.toMatch(/\s(?:src|href)=|\sstyle=|\son\w+=/i)
      expect(style.match(/url\([^)]*\)/gi) ?? []).toEqual([])
    },
  )
})
