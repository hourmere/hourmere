import { afterEach, describe, expect, it, vi } from 'vitest'
import { closePopup, destroyInline, iframeUrl, init, initInline, openPopup } from './widget.ts'

const url = 'https://hourmere.test/ada/intro'
const handles: ReturnType<typeof initInline>[] = []
const dialogMethods = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal'),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close'),
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
    const dialog = document.querySelector('dialog') as HTMLDialogElement,
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
      booked = vi.fn()
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
    const dialog = document.querySelector('dialog') as HTMLDialogElement,
      close = dialog.querySelector('button') as HTMLButtonElement
    expect(document.activeElement).toBe(close)
    expect(close.getAttribute('aria-label')).toBe('Close booking')
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    expect(document.querySelector('dialog')).toBeNull()
    expect(document.activeElement).toBe(open)
    openPopup({ url })
    openPopup({ url })
    expect(document.querySelectorAll('dialog')).toHaveLength(1)
    const other = mount(),
      active = document.querySelector('dialog iframe') as HTMLIFrameElement,
      src = new URL(active.src),
      id = src.searchParams.get('embedId')
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: src.origin,
        source: other.iframe.contentWindow,
        data: { type: 'hourmere:close', id },
      }),
    )
    expect(document.querySelector('dialog')).not.toBeNull()
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: src.origin,
        source: other.iframe.contentWindow,
        data: { type: 'hourmere:close', id: new URL(other.iframe.src).searchParams.get('embedId') },
      }),
    )
    expect(document.querySelector('dialog')).not.toBeNull()
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: src.origin,
        source: active.contentWindow,
        data: { type: 'hourmere:close', id },
      }),
    )
    expect(document.querySelector('dialog')).toBeNull()
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
      retired = document.querySelector('dialog') as HTMLDialogElement
    openPopup({ url: 'https://hourmere.test/ada/second' })
    const replacement = document.querySelector('dialog') as HTMLDialogElement
    await Promise.resolve()
    expect(replacement.isConnected).toBe(true)
    expect(replacement.hasAttribute('open')).toBe(true)
    expect(document.querySelectorAll('dialog')).toHaveLength(1)
    first.close()
    retired.dispatchEvent(new Event('cancel', { cancelable: true }))
    retired.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(replacement.isConnected).toBe(true)
    closePopup()
    openPopup({ url })
    const reopened = document.querySelector('dialog') as HTMLDialogElement
    await Promise.resolve()
    expect(reopened.isConnected).toBe(true)
    reopened.close()
    await Promise.resolve()
    expect(document.querySelector('dialog')).toBeNull()
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
    const dialog = document.querySelector('dialog') as HTMLDialogElement
    expect(dialog.querySelector('h2')?.textContent).toBe('预约会议')
    expect(dialog.querySelector('button')?.getAttribute('aria-label')).toBe('关闭预约窗口')
    const frame = dialog.querySelector('iframe') as HTMLIFrameElement
    expect(new URL(frame.src).searchParams.get('language')).toBe('zh-CN')
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    expect(document.querySelector('dialog')).toBeNull()
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
