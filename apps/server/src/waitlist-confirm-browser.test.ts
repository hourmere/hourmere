// @vitest-environment jsdom
import { runInNewContext } from 'node:vm'
import { interfaceLanguages } from '@hourmere/core/language'
import { Hono, type MiddlewareHandler } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitlistConfirmationCatalogues } from './i18n/waitlist-confirmation.ts'
import { inlineAsset } from './sign-in-confirm-testing.ts'
import { registerWaitlistConfirmation } from './waitlist-confirm.ts'

// Keep browser-only types local; loading lib.dom here changes the server's fetch types.
interface BrowserElement {
  hidden: boolean
  disabled: boolean
  value: string
  textContent: string | null
  click(): void
  dispatchEvent(event: Event): boolean
}
declare const document: {
  documentElement: { innerHTML: string; outerHTML: string; lang: string }
  getElementById(id: string): BrowserElement | null
}
declare const history: { replaceState(data: null, unused: string, url: string): void }
declare const location: { hash: string; search: string }
declare const Storage: { prototype: { setItem(key: string, value: string): void } }

// Socket address resolution is exercised by the HTTP transport tests, outside jsdom.
vi.mock('./client-ip.ts', () => ({
  clientIp: (): MiddlewareHandler => async (_c, next) => {
    await next()
  },
}))

// Non-secret fixtures have the same constrained shape as production capabilities.
const verification = `00000000-0000-4000-8000-000000000001.${'v'.repeat(43)}`
const management = `00000000-0000-4000-8000-000000000001.${'m'.repeat(43)}`

async function browser(
  path = '/waitlist/verify',
  fragment = `token=${verification}&management=${management}`,
  language = 'en',
  mutation?: { before: string; after: string },
) {
  const verify = vi.fn(async () => ({}))
  const remove = vi.fn(async () => ({}))
  const app = new Hono()
  registerWaitlistConfirmation(app, { publicUrl: 'https://schedule.example', verify, remove })
  const response = await app.request(path, { headers: { 'Accept-Language': language } })
  const html = await response.text()
  document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, '')
  document.documentElement.lang = language
  history.replaceState(null, '', `${path}#${fragment}`)
  const fetch = vi.fn(async (_path: string, _init: RequestInit) => new Response('{}'))
  const localStorage = vi.spyOn(Storage.prototype, 'setItem')
  let script = inlineAsset(html, 'script')
  if (mutation) {
    expect(
      script.includes(mutation.before),
      'mutation matches the rendered source protection',
    ).toBe(true)
    script = script.replace(mutation.before, mutation.after)
  }
  runInNewContext(script, { document, location, history, URLSearchParams, fetch })
  const action = document.getElementById('action') as BrowserElement
  const leave = document.getElementById('remove') as BrowserElement
  const selector = document.getElementById('language') as BrowserElement
  return { action, leave, selector, fetch, localStorage, verify, remove, script }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.innerHTML = ''
  history.replaceState(null, '', '/')
})

describe('waitlist mail-link confirmation in the browser', () => {
  it.each(interfaceLanguages('public'))(
    'renders natural %s copy and changes language without posting or persisting a capability',
    async (language) => {
      const ui = await browser('/waitlist/verify', undefined, language)
      const words = waitlistConfirmationCatalogues[language]
      expect(document.getElementById('title')?.textContent).toBe(words.verifyTitle)
      expect(ui.action.textContent).toBe(words.verifyAction)
      expect(ui.action.hidden).toBe(false)
      expect(location.hash).toBe('')
      expect(location.search).toBe('')
      expect(ui.fetch).not.toHaveBeenCalled()
      expect(ui.verify).not.toHaveBeenCalled()
      expect(ui.remove).not.toHaveBeenCalled()
      expect(ui.localStorage).not.toHaveBeenCalled()
      expect(document.documentElement.outerHTML.includes(verification)).toBe(false)
      expect(document.documentElement.outerHTML.includes(management)).toBe(false)
      ui.selector.value = language === 'en' ? 'zh-CN' : 'en'
      ui.selector.dispatchEvent(new Event('change'))
      expect(document.documentElement.lang).toBe(ui.selector.value)
      expect(ui.fetch).not.toHaveBeenCalled()
      expect(ui.localStorage).not.toHaveBeenCalled()
    },
  )

  it('posts only after confirmation, retains self-removal, and puts tokens only in the JSON body', async () => {
    const ui = await browser()
    ui.action.click()
    await vi.waitFor(() => expect(ui.action.hidden).toBe(true))
    expect(document.getElementById('status')?.textContent).toBe(
      waitlistConfirmationCatalogues.en.verified,
    )
    expect(ui.leave.hidden).toBe(false)
    ui.leave.click()
    await vi.waitFor(() => expect(ui.leave.hidden).toBe(true))
    expect(ui.fetch.mock.calls.length).toBe(2)
    for (const [path, init] of ui.fetch.mock.calls) {
      const url = new URL(path, 'https://schedule.example')
      expect(url.search).toBe('')
      expect(url.hash).toBe('')
      expect(path.includes(verification) || path.includes(management)).toBe(false)
      expect(init).toMatchObject({
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      })
    }
    expect(ui.fetch.mock.calls[0]?.[0]).toBe('/waitlist/verify')
    expect(JSON.parse(String(ui.fetch.mock.calls[0]?.[1].body)).token === verification).toBe(true)
    expect(ui.fetch.mock.calls[1]?.[0]).toBe('/waitlist/remove')
    expect(JSON.parse(String(ui.fetch.mock.calls[1]?.[1].body)).token === management).toBe(true)
    expect(ui.localStorage).not.toHaveBeenCalled()
  })

  it('removes from a raw management fragment with a single explicit click and no automatic request', async () => {
    const ui = await browser('/waitlist/remove', management)
    expect(ui.fetch).not.toHaveBeenCalled()
    expect(location.hash).toBe('')
    ui.action.click()
    await vi.waitFor(() => expect(ui.action.hidden).toBe(true))
    expect(ui.fetch).toHaveBeenCalledTimes(1)
    expect(ui.fetch.mock.calls[0]?.[0]).toBe('/waitlist/remove')
    expect(JSON.parse(String(ui.fetch.mock.calls[0]?.[1].body)).token === management).toBe(true)
    expect(document.getElementById('status')?.textContent).toBe(
      waitlistConfirmationCatalogues.en.removed,
    )
  })

  it('rejects incomplete fragments locally and never leaves the fragment in history', async () => {
    const ui = await browser('/waitlist/verify', 'not-a-capability')
    expect(ui.action.hidden).toBe(true)
    expect(ui.leave.hidden).toBe(true)
    expect(location.hash).toBe('')
    expect(ui.fetch).not.toHaveBeenCalled()
    expect(document.getElementById('status')?.textContent).toBe(
      waitlistConfirmationCatalogues.en.incomplete,
    )
  })

  it('detects removed history scrubbing in an isolated inline-source copy', async () => {
    await browser(undefined, undefined, undefined, {
      before: "history.replaceState(null, '', location.pathname);",
      after: '',
    })
    expect(() => expect(location.hash).toBe('')).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('detects scanner-triggered POST in an isolated inline-source copy', async () => {
    const ui = await browser(undefined, undefined, undefined, {
      before: '  render();\n})();',
      after: '  render();\n  void submit(false);\n})();',
    })
    expect(() => expect(ui.fetch).not.toHaveBeenCalled()).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('detects putting a capability into a query string in an isolated inline-source copy', async () => {
    const ui = await browser(undefined, undefined, undefined, {
      before: "removing ? '/waitlist/remove' : '/waitlist/verify'",
      after: "(removing ? '/waitlist/remove' : '/waitlist/verify') + '?token=' + capability",
    })
    ui.action.click()
    await vi.waitFor(() => expect(ui.action.hidden).toBe(true))
    const path = ui.fetch.mock.calls[0]?.[0]
    expect(() => expect(new URL(String(path), 'https://schedule.example').search).toBe('')).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('shows safe invalid/limited/error copy, retains removal, and prevents double clicks during a request', async () => {
    const ui = await browser()
    let release: ((response: Response) => void) | undefined
    ui.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    ui.action.click()
    ui.action.click()
    expect(ui.fetch).toHaveBeenCalledTimes(1)
    release?.(new Response('{}', { status: 404 }))
    await vi.waitFor(() => expect(ui.action.hidden).toBe(true))
    expect(document.getElementById('status')?.textContent).toBe(
      waitlistConfirmationCatalogues.en.invalid,
    )
    expect(ui.leave.hidden).toBe(false)
    ui.fetch.mockResolvedValueOnce(new Response('{}', { status: 429 }))
    ui.leave.click()
    await vi.waitFor(() => expect(ui.leave.disabled).toBe(false))
    expect(document.getElementById('status')?.textContent).toBe(
      waitlistConfirmationCatalogues.en.retry,
    )
    ui.fetch.mockRejectedValueOnce(new Error('network unavailable'))
    ui.leave.click()
    await vi.waitFor(() => expect(ui.leave.disabled).toBe(false))
    expect(document.getElementById('status')?.textContent).toBe(
      waitlistConfirmationCatalogues.en.unavailable,
    )
  })
})
