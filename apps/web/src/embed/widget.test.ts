import { afterEach, describe, expect, it, vi } from 'vitest'
import { closePopup, destroyInline, iframeUrl, init, initInline, openPopup } from './widget.ts'

const url = 'https://hourmere.test/ada/intro'
const handles: ReturnType<typeof initInline>[] = []
const dialogMethods = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal'),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close'),
}
function popupRoot() {
  return document.querySelector('[data-hourmere-popup-host]')?.shadowRoot ?? null
}
function popupDialog() {
  return popupRoot()?.querySelector('dialog') ?? null
}
function stubDialogs() {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    },
  })
}
function mount(raw = url) {
  const element = document.createElement('div')
  document.body.append(element)
  const handle = initInline({ element, url: raw })
  handles.push(handle)
  return { element, ...handle }
}
afterEach(() => {
  closePopup()
  for (const handle of handles.splice(0)) handle.destroy()
  document.body.replaceChildren()
  document.documentElement.removeAttribute('lang')
  document.documentElement.removeAttribute('style')
  document.body.removeAttribute('style')
  for (const key of ['showModal', 'close'] as const) {
    const descriptor = dialogMethods[key]
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, key, descriptor)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, key)
  }
})
describe('standalone booking widget', () => {
  it('creates independent inline frame IDs without randomUUID on plain HTTP', () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    expect(() => mount()).not.toThrow()
    const first = mount(),
      second = mount(),
      firstId = new URL(first.iframe.src).searchParams.get('embedId'),
      secondId = new URL(second.iframe.src).searchParams.get('embedId')
    expect(firstId).toMatch(/^[a-f0-9]{32}$/)
    expect(secondId).toMatch(/^[a-f0-9]{32}$/)
    expect(secondId).not.toBe(firstId)
  })
  it('opens a labelled popup without randomUUID on plain HTTP', () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    for (const method of ['showModal', 'close'] as const)
      Object.defineProperty(HTMLDialogElement.prototype, method, {
        configurable: true,
        value: vi.fn(),
      })
    expect(() => openPopup({ url })).not.toThrow()
    const dialog = popupDialog() as HTMLDialogElement,
      title = dialog.querySelector('h2') as HTMLHeadingElement,
      frame = dialog.querySelector('iframe') as HTMLIFrameElement
    expect(title.id).toMatch(/^hourmere-title-[a-f0-9]{32}$/)
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id)
    expect(new URL(frame.src).searchParams.get('embedId')).toMatch(/^[a-f0-9]{32}$/)
    expect(dialog.showModal).toHaveBeenCalledOnce()
  })
  it('constructs an isolated frame for only public personal/team URLs', () => {
    const a = mount(),
      src = new URL(a.iframe.src)
    expect(src.pathname).toBe('/embed/ada/intro')
    expect(src.searchParams.get('parentOrigin')).toBe(window.location.origin)
    expect(a.iframe.referrerPolicy).toBe('no-referrer')
    expect(a.iframe.title).toBe('Book a meeting with Hourmere')
    const sandbox = a.iframe.getAttribute('sandbox') as string
    for (const value of [
      'allow-scripts',
      'allow-forms',
      'allow-popups',
      'allow-popups-to-escape-sandbox',
      'allow-downloads',
    ])
      expect(sandbox.split(' ')).toContain(value)
    expect(sandbox).not.toContain('allow-top-navigation')
    expect(new URL(mount('https://hourmere.test/team/Alpha/intro').iframe.src).pathname).toBe(
      '/embed/team/Alpha/intro',
    )
  })
  it.each([
    'javascript:alert(1)',
    'https://u:p@hourmere.test/ada/intro',
    'https://hourmere.test/app/settings',
    'https://hourmere.test/api/auth',
    'https://hourmere.test/booking/token',
    'https://hourmere.test/oauth/consent',
    'https://hourmere.test/ada/intro#token=secret',
    'https://hourmere.test/ada/intro?token=secret',
    'http://external.test/ada/intro',
    'https://%2a/ada/intro',
    'https://%2A.example.invalid/ada/intro',
    'https://＊.example.invalid/ada/intro',
    '/ada/intro',
  ])('refuses unsafe or sensitive URL %s', (raw) =>
    expect(() => iframeUrl(raw, window.location.origin, 'abcdefghijklmnop')).toThrow(),
  )
  it('rejects wildcard hosts that browser URL parsers expose as percent escapes', () => {
    // Chrome 155 represents wildcard hosts as %2A; Node 26 exposes a literal *.
    // Preserve that independently observed browser representation in the DOM regression.
    const NativeURL = URL
    class BrowserURL extends NativeURL {
      override get hostname() {
        return super.hostname.replaceAll('*', '%2A')
      }
      override get origin() {
        return super.origin.replaceAll('*', '%2A')
      }
    }
    vi.stubGlobal('URL', BrowserURL)
    try {
      expect(() => iframeUrl(url, window.location.origin, 'abcdefghijklmnop')).not.toThrow()
      for (const origin of [
        'https://*',
        'https://*.example.invalid',
        'https://%2a',
        'https://%2A.example.invalid',
        'https://＊.example.invalid',
        'https://%EF%BC%8A.example.invalid',
        'https://foo.%2a.example.invalid',
        'https://＊。example.invalid',
      ])
        expect(() =>
          iframeUrl(`${origin}/ada/intro`, window.location.origin, 'abcdefghijklmnop'),
        ).toThrow()
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('accepts resize/completion only from the exact frame, origin and instance', () => {
    const a = mount(),
      b = mount(),
      src = new URL(a.iframe.src),
      id = src.searchParams.get('embedId'),
      booked = vi.fn(),
      parentBooked = vi.fn(),
      parent = document.createElement('section')
    document.body.append(parent)
    parent.append(a.element)
    parent.addEventListener('hourmere:booking-completed', parentBooked)
    a.element.addEventListener('hourmere:booking-completed', booked)
    const send = (data: unknown, origin = src.origin, source = a.iframe.contentWindow) =>
      window.dispatchEvent(new MessageEvent('message', { data, origin, source }))
    for (const [origin, source, frameId] of [
      ['https://evil.test', a.iframe.contentWindow, id],
      [src.origin, b.iframe.contentWindow, id],
      [src.origin, a.iframe.contentWindow, 'other'],
    ]) {
      send(
        { type: 'hourmere:resize', id: frameId, height: 400 },
        origin as string,
        source as Window,
      )
      send({ type: 'hourmere:booked', id: frameId }, origin as string, source as Window)
    }
    expect(a.iframe.style.height).toBe('720px')
    expect(booked).not.toHaveBeenCalled()
    for (const height of [239, 2001, Infinity, NaN, '400', 400.5])
      send({ type: 'hourmere:resize', id, height })
    expect(a.iframe.style.height).toBe('720px')
    send({ type: 'hourmere:resize', id, height: 500 })
    expect(a.iframe.style.height).toBe('500px')
    send({ type: 'hourmere:booked', id, token: 'must-not-forward', attendees: ['private'] })
    expect(booked).toHaveBeenCalledOnce()
    expect(parentBooked).toHaveBeenCalledOnce()
    expect((booked.mock.calls[0]?.[0] as CustomEvent | undefined)?.detail).toBeNull()
    a.destroy()
    send({ type: 'hourmere:booked', id })
    expect(booked).toHaveBeenCalledOnce()
  })
  it('replaces and disposes frames without retaining message handlers', () => {
    const a = mount(),
      b = initInline({ element: a.element, url: 'https://hourmere.test/ada/second' })
    handles.push(b)
    expect(a.iframe.isConnected).toBe(false)
    expect(a.element.querySelectorAll('iframe')).toHaveLength(1)
    a.destroy()
    expect(b.iframe.isConnected).toBe(true)
    destroyInline(a.element)
    expect(b.iframe.isConnected).toBe(false)
  })
  it('bubbles popup completion from its opener without forwarding private message data', () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.setAttribute('open', '')
      },
    })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.removeAttribute('open')
      },
    })
    const opener = document.createElement('button'),
      completed = vi.fn(),
      documentCompleted = vi.fn()
    opener.dataset.hourmerePopup = ''
    opener.dataset.hourmereUrl = url
    document.body.append(opener)
    opener.addEventListener('hourmere:booking-completed', completed)
    document.addEventListener('hourmere:booking-completed', documentCompleted)
    try {
      init()
      opener.click()
      const frame = popupRoot()?.querySelector('iframe') as HTMLIFrameElement,
        src = new URL(frame.src),
        id = src.searchParams.get('embedId'),
        other = mount(),
        send = (origin: string, source: Window | null, frameId = id) =>
          window.dispatchEvent(
            new MessageEvent('message', {
              origin,
              source,
              data: {
                type: 'hourmere:booked',
                id: frameId,
                manageToken: 'private-capability',
                attendees: ['private@example.test'],
              },
            }),
          )
      send('https://other.test', frame.contentWindow)
      send(src.origin, other.iframe.contentWindow)
      send(src.origin, frame.contentWindow, 'different-instance')
      expect(completed).not.toHaveBeenCalled()
      expect(documentCompleted).not.toHaveBeenCalled()
      send(src.origin, frame.contentWindow)
      expect(completed).toHaveBeenCalledOnce()
      expect(documentCompleted).toHaveBeenCalledOnce()
      const event = completed.mock.calls[0]?.[0] as CustomEvent
      expect(event.target).toBe(opener)
      expect(event.bubbles).toBe(true)
      expect(event.detail).toBeNull()
      closePopup()
      send(src.origin, frame.contentWindow)
      expect(completed).toHaveBeenCalledOnce()
      opener.focus()
      openPopup({ url })
      const replacement = popupRoot()?.querySelector('iframe') as HTMLIFrameElement,
        replacementUrl = new URL(replacement.src)
      opener.remove()
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: replacementUrl.origin,
          source: replacement.contentWindow,
          data: { type: 'hourmere:booked', id: replacementUrl.searchParams.get('embedId') },
        }),
      )
      expect(completed).toHaveBeenCalledOnce()
      expect(documentCompleted).toHaveBeenCalledTimes(2)
      expect(documentCompleted.mock.calls[1]?.[0].target).toBe(document)
      expect(documentCompleted.mock.calls[1]?.[0].detail).toBeNull()
    } finally {
      document.removeEventListener('hourmere:booking-completed', documentCompleted)
    }
  })
  it('uses a modal dialog, restores focus and cleans up on Escape or closing', () => {
    const open = document.createElement('button')
    document.body.append(open)
    open.focus()
    const show = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    })
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: show,
    })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.removeAttribute('open')
      },
    })
    openPopup({ url })
    expect(show).toHaveBeenCalledOnce()
    const dialog = popupDialog() as HTMLDialogElement,
      close = dialog.querySelector('button') as HTMLButtonElement
    expect(popupRoot()?.activeElement).toBe(close)
    expect(close.getAttribute('aria-label')).toBe('Close booking')
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    expect(popupDialog()).toBeNull()
    expect(document.activeElement).toBe(open)
    openPopup({ url })
    openPopup({ url })
    expect(document.querySelectorAll('[data-hourmere-popup-host]')).toHaveLength(1)
    const other = mount(),
      active = popupRoot()?.querySelector('iframe') as HTMLIFrameElement,
      src = new URL(active.src),
      id = src.searchParams.get('embedId')
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: src.origin,
        source: other.iframe.contentWindow,
        data: { type: 'hourmere:close', id },
      }),
    )
    expect(popupDialog()).not.toBeNull()
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: src.origin,
        source: other.iframe.contentWindow,
        data: { type: 'hourmere:close', id: new URL(other.iframe.src).searchParams.get('embedId') },
      }),
    )
    expect(popupDialog()).not.toBeNull()
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: src.origin,
        source: active.contentWindow,
        data: { type: 'hourmere:close', id },
      }),
    )
    expect(popupDialog()).toBeNull()
    other.destroy()
    closePopup()
    expect(document.querySelector('iframe')).toBeNull()
    const trigger = document.createElement('button')
    trigger.dataset.hourmerePopup = ''
    trigger.dataset.hourmereUrl = url
    document.body.append(trigger)
    init()
    trigger.click()
    closePopup()
    expect(document.activeElement).toBe(trigger)
  })
  it('ignores queued native close events and handles from a retired popup', async () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.setAttribute('open', '')
      },
    })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        if (!this.hasAttribute('open')) return
        this.removeAttribute('open')
        queueMicrotask(() => this.dispatchEvent(new Event('close')))
      },
    })
    const first = openPopup({ url }),
      retired = popupDialog() as HTMLDialogElement
    openPopup({ url: 'https://hourmere.test/ada/second' })
    const replacement = popupDialog() as HTMLDialogElement
    await Promise.resolve()
    expect(replacement.isConnected).toBe(true)
    expect(replacement.hasAttribute('open')).toBe(true)
    expect(document.querySelectorAll('[data-hourmere-popup-host]')).toHaveLength(1)
    first.close()
    retired.dispatchEvent(new Event('cancel', { cancelable: true }))
    retired.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(replacement.isConnected).toBe(true)
    closePopup()
    openPopup({ url })
    const reopened = popupDialog() as HTMLDialogElement
    await Promise.resolve()
    expect(reopened.isConnected).toBe(true)
    reopened.close()
    await Promise.resolve()
    expect(popupDialog()).toBeNull()
  })
  it('initializes declarative inline placeholders once', () => {
    const element = document.createElement('div')
    element.dataset.hourmereInline = ''
    element.dataset.hourmereUrl = url
    document.body.append(element)
    init()
    init()
    expect(element.querySelectorAll('iframe')).toHaveLength(1)
    destroyInline(element)
  })
})

describe('standalone widget languages', () => {
  it('uses the explicit tiny language option in frame labels and query', () => {
    const element = document.createElement('div')
    document.body.append(element)
    const handle = initInline({ element, url, language: 'zh-CN' })
    handles.push(handle)
    expect(handle.iframe.title).toBe('通过 Hourmere 预约会议')
    const query = new URL(handle.iframe.src).searchParams
    expect(query.get('language')).toBe('zh-CN')
    expect([...query.keys()].sort()).toEqual(['embedId', 'language', 'parentOrigin'])
  })
  it.each(['zh', 'EN', 'zh-TW', 'en-US', '__proto__', 'constructor', 'zh-CN&token=private'])(
    'rejects unsupported explicit language %s before replacing an existing frame',
    (language) => {
      const initial = mount()
      expect(() =>
        initInline({ element: initial.element, url, language: language as 'en' }),
      ).toThrow('Invalid Hourmere interface language')
      expect(initial.iframe.isConnected).toBe(true)
      expect(initial.element.querySelectorAll('iframe')).toHaveLength(1)
    },
  )
  it('localizes popup controls while keeping the original sender and cleanup guards', () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.setAttribute('open', '')
      },
    })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.removeAttribute('open')
      },
    })
    openPopup({ url, language: 'zh-CN' })
    const dialog = popupDialog() as HTMLDialogElement
    expect(dialog.querySelector('h2')?.textContent).toBe('预约会议')
    expect(dialog.querySelector('button')?.getAttribute('aria-label')).toBe('关闭预约窗口')
    const frame = dialog.querySelector('iframe') as HTMLIFrameElement
    expect(new URL(frame.src).searchParams.get('language')).toBe('zh-CN')
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    expect(popupDialog()).toBeNull()
  })
  it('supports declarative language and uses the same language for failure messages', () => {
    const element = document.createElement('div')
    element.dataset.hourmereInline = ''
    element.dataset.hourmereUrl = 'javascript:invalid'
    element.dataset.hourmereLanguage = 'zh-CN'
    document.body.append(element)
    init()
    expect(element.querySelector('[role="alert"]')?.textContent).toBe(
      '预约组件无法加载。请检查 Hourmere 地址和实例的嵌入设置。',
    )
    expect(element.querySelector('iframe')).toBeNull()
  })
})

describe('popup chrome protections', () => {
  const rect = { left: 20, right: 420, top: 30, bottom: 530 }
  function open() {
    stubDialogs()
    const handle = openPopup({ url }),
      dialog = popupDialog() as HTMLDialogElement
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(rect as DOMRect)
    return { handle, dialog }
  }
  it('keeps dialog padding, edges and descendant clicks open', () => {
    const { dialog } = open()
    for (const [clientX, clientY] of [
      [21, 31],
      [20, 30],
      [420, 530],
      [419, 529],
    ]) {
      dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY }))
      expect(dialog.isConnected).toBe(true)
    }
    dialog.querySelector('h2')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(dialog.isConnected).toBe(true)
  })
  it.each([
    [19, 100],
    [421, 100],
    [100, 29],
    [100, 531],
  ])('closes only for a backdrop click outside the rect at %i,%i', (clientX, clientY) => {
    const { dialog } = open()
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY }))
    expect(popupDialog()).toBeNull()
  })
  it('isolates every chrome element from host selectors and inherited styles', () => {
    stubDialogs()
    openPopup({ url })
    expect(popupRoot()).not.toBeNull()
    const root = popupRoot() as ShadowRoot,
      host = root.host as HTMLElement
    expect(document.querySelector('dialog')).toBeNull()
    expect(document.querySelector('h2')).toBeNull()
    expect(host.style.getPropertyValue('all')).toBe('initial')
    expect(host.style.getPropertyPriority('all')).toBe('important')
    expect(host.style.getPropertyValue('display')).toBe('contents')
    expect(host.style.getPropertyPriority('display')).toBe('important')
    for (const tag of ['dialog', 'h2', 'button', 'iframe'])
      expect(root.querySelector(tag)?.getRootNode()).toBe(root)
    const css = root.querySelector('style')?.textContent ?? ''
    expect(css).toMatch(/dialog\s*\{\s*all: revert;/)
    expect(css).toContain('font: 16px/1.5 system-ui, sans-serif;')
    expect(css).toContain('text-align: start;')
    expect(css).toContain('direction: ltr;')
    expect(css).toMatch(/button:focus-visible\s*\{[^}]*outline: 2px solid Highlight;/)
  })
  it('adopts a constructed sheet without adding a CSP-blocked inline style element', () => {
    const descriptor = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'adoptedStyleSheets'),
      sheets: ConstructedSheet[] = []
    class ConstructedSheet {
      replaceSync(_css: string) {}
      constructor() {
        sheets.push(this)
      }
    }
    const replaceSync = vi.spyOn(ConstructedSheet.prototype, 'replaceSync')
    vi.stubGlobal('CSSStyleSheet', ConstructedSheet)
    Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', {
      configurable: true,
      writable: true,
      value: [],
    })
    try {
      open()
      const root = popupRoot() as ShadowRoot
      expect(root.querySelector('style')).toBeNull()
      expect(sheets).toHaveLength(1)
      expect(root.adoptedStyleSheets).toEqual([sheets[0]])
      expect(replaceSync).toHaveBeenCalledOnce()
      expect(replaceSync.mock.calls[0]?.[0]).toContain('color-scheme: light dark;')
    } finally {
      if (descriptor) Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', descriptor)
      else Reflect.deleteProperty(ShadowRoot.prototype, 'adoptedStyleSheets')
    }
  })
  it('follows the visitor color scheme and visibly dims the backdrop', () => {
    open()
    const css = popupRoot()?.querySelector('style')?.textContent ?? ''
    expect(css).toContain('color-scheme: light dark;')
    expect(css).toMatch(/dialog\s*\{[^}]*color: CanvasText;[^}]*background: Canvas;/)
    expect(css).toContain('border: 1px solid GrayText;')
    expect(css).toMatch(/dialog::backdrop\s*\{\s*background: rgb\(0 0 0 \/ .5\);/)
  })
  it('uses dynamic viewport limits with fallbacks and one contained content scroller', () => {
    open()
    const css = popupRoot()?.querySelector('style')?.textContent ?? '',
      desktop = css.slice(0, css.indexOf('@media'))
    expect(desktop).toMatch(/max-height: 90vh;\s*max-height: 90dvh;/)
    expect(desktop).toContain('overflow: hidden;')
    expect(desktop).toMatch(/dialog\s*\{[^}]*overscroll-behavior: contain;/)
    expect(desktop).toMatch(
      /\.content\s*\{[^}]*min-height: 0;[^}]*overflow: auto;[^}]*overscroll-behavior: contain;/,
    )
  })
  it('fills small viewports without frame padding or borders', () => {
    open()
    const css = popupRoot()?.querySelector('style')?.textContent ?? '',
      mobile = css.slice(css.indexOf('@media'))
    expect(mobile).toMatch(/^@media \(max-width: 480px\)/)
    expect(mobile).toContain('width: 100vw;')
    expect(mobile).toContain('max-width: 100vw;')
    expect(mobile).toMatch(/height: 100vh;\s*height: 100dvh;/)
    expect(mobile).toMatch(/max-height: 100vh;\s*max-height: 100dvh;/)
    for (const declaration of ['padding: 0;', 'margin: 0;', 'border: 0;', 'border-radius: 0;'])
      expect(mobile).toContain(declaration)
    expect(mobile).toMatch(/\.content\s*\{\s*flex: 1;/)
  })
  it('places a labelled 44 by 44 close control at the end of the title row', () => {
    open()
    const root = popupRoot() as ShadowRoot,
      header = root.querySelector('header') as HTMLElement,
      close = header.lastElementChild as HTMLButtonElement,
      css = root.querySelector('style')?.textContent ?? ''
    expect(header.firstElementChild?.tagName).toBe('H2')
    expect(close.tagName).toBe('BUTTON')
    expect(close.textContent).toBe('×')
    expect(close.getAttribute('aria-label')).toBe('Close booking')
    expect(css).toMatch(/header\s*\{[^}]*display: flex;[^}]*justify-content: space-between;/)
    expect(css).toMatch(/button\s*\{[^}]*width: 44px;[^}]*height: 44px;/)
    close.click()
    expect(popupDialog()).toBeNull()
  })
  it('locks the page and restores existing scroll declarations including priorities', () => {
    document.documentElement.style.setProperty('overflow', 'clip', 'important')
    document.body.style.setProperty('overflow-x', 'scroll')
    document.body.style.setProperty('overflow-y', 'auto', 'important')
    document.body.style.setProperty('color', 'red')
    open()
    for (const element of [document.documentElement, document.body]) {
      expect(element.style.getPropertyValue('overflow')).toBe('hidden')
      expect(element.style.getPropertyPriority('overflow')).toBe('important')
    }
    document.body.style.setProperty('color', 'blue')
    closePopup()
    expect(document.documentElement.style.getPropertyValue('overflow')).toBe('clip')
    expect(document.documentElement.style.getPropertyPriority('overflow')).toBe('important')
    expect(document.body.style.getPropertyValue('overflow-x')).toBe('scroll')
    expect(document.body.style.getPropertyValue('overflow-y')).toBe('auto')
    expect(document.body.style.getPropertyPriority('overflow-y')).toBe('important')
    expect(document.body.style.color).toBe('blue')
  })
  it('keeps the replacement locked and validates options before replacing it', () => {
    const first = open()
    openPopup({ url })
    const current = popupDialog()
    first.handle.close()
    expect(document.body.style.overflow).toBe('hidden')
    expect(() => openPopup({ url: 'javascript:bad' })).toThrow()
    expect(() => openPopup({ url, language: 'fr' as 'en' })).toThrow()
    expect(popupDialog()).toBe(current)
    expect(document.documentElement.style.overflow).toBe('hidden')
    closePopup()
    expect(document.documentElement.style.overflow).toBe('')
    expect(document.body.style.overflow).toBe('')
  })
  it('restores scrolling and opener focus when showModal fails', () => {
    stubDialogs()
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    document.body.style.overflow = 'auto'
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {
      throw new Error('Modal unavailable')
    })
    expect(() => openPopup({ url })).toThrow('Modal unavailable')
    expect(popupDialog()).toBeNull()
    expect(document.querySelector('[data-hourmere-popup-host]')).toBeNull()
    expect(document.body.style.overflow).toBe('auto')
    expect(document.documentElement.style.overflow).toBe('')
    expect(document.activeElement).toBe(opener)
  })
})

describe('declarative widget protections', () => {
  function placeholder(height?: string) {
    const element = document.createElement('div')
    element.dataset.hourmereInline = ''
    element.dataset.hourmereUrl = url
    if (height !== undefined) element.dataset.hourmereHeight = height
    document.body.append(element)
    return element
  }
  it.each(['240', '640', '2000'])('uses the declared initial height %s', (height) => {
    const element = placeholder(height)
    init()
    expect(element.querySelector('iframe')?.style.height).toBe(`${height}px`)
    destroyInline(element)
  })
  it.each(['', '239', '2001', '720px', 'Infinity', '240.5'])(
    'refuses invalid declared height %s',
    (height) => {
      const element = placeholder(height)
      init()
      expect(element.querySelector('iframe')).toBeNull()
      expect(element.querySelectorAll('[role="alert"]')).toHaveLength(1)
    },
  )
  it('reuses a single inline error and clears it after recovery', () => {
    const element = placeholder()
    element.dataset.hourmereUrl = 'javascript:bad'
    init()
    const status = element.querySelector('[role="alert"]')
    init()
    expect(element.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(element.querySelector('[role="alert"]')).toBe(status)
    element.dataset.hourmereUrl = url
    init()
    expect(element.querySelector('iframe')).not.toBeNull()
    expect(element.querySelector('[role="alert"]')).toBeNull()
    destroyInline(element)
  })
  it('reuses one error per popup trigger and clears only the recovered trigger', () => {
    stubDialogs()
    const first = document.createElement('button'),
      second = document.createElement('button')
    for (const trigger of [first, second]) {
      trigger.dataset.hourmerePopup = ''
      trigger.dataset.hourmereUrl = 'javascript:bad'
      document.body.append(trigger)
    }
    init()
    first.click()
    const status = document.querySelector('[role="alert"]')
    first.click()
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(document.querySelector('[role="alert"]')).toBe(status)
    second.click()
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(2)
    first.dataset.hourmereUrl = url
    first.click()
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(status?.isConnected).toBe(false)
  })
})

describe('host page language defaults', () => {
  it.each([
    ['en-US', 'zh-CN', 'en'],
    ['zh-CN', 'en-US', 'zh-CN'],
    ['zh-Hans', 'en-US', 'zh-CN'],
  ])('prefers host %s over browser %s', (page, browser, expected) => {
    document.documentElement.lang = page
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue([browser])
    const { iframe } = mount()
    expect(new URL(iframe.src).searchParams.get('language')).toBe(expected)
  })
  it.each(['', 'fr', 'zh-TW', 'invalid tag'])('falls back from host %s to the browser', (page) => {
    document.documentElement.lang = page
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr', 'zh-CN'])
    const { iframe } = mount()
    expect(new URL(iframe.src).searchParams.get('language')).toBe('zh-CN')
  })
  it('retains explicit option priority over the host language', () => {
    document.documentElement.lang = 'zh-CN'
    const element = document.createElement('div')
    document.body.append(element)
    const handle = initInline({ element, url, language: 'en' })
    handles.push(handle)
    expect(new URL(handle.iframe.src).searchParams.get('language')).toBe('en')
  })
  it('uses the host language for declarative popup controls and load errors', () => {
    stubDialogs()
    document.documentElement.lang = 'zh-CN'
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US'])
    const trigger = document.createElement('button')
    trigger.dataset.hourmerePopup = ''
    trigger.dataset.hourmereUrl = 'javascript:bad'
    document.body.append(trigger)
    init()
    trigger.click()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('预约组件无法加载。')
    trigger.dataset.hourmereUrl = url
    trigger.click()
    expect(popupDialog()?.lang).toBe('zh-CN')
    expect(popupRoot()?.querySelector('button')?.getAttribute('aria-label')).toBe('关闭预约窗口')
    expect(
      new URL(popupRoot()?.querySelector('iframe')?.src ?? '').searchParams.get('language'),
    ).toBe('zh-CN')
  })
})
