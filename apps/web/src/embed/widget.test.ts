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
    '/ada/intro',
  ])('refuses unsafe or sensitive URL %s', (raw) =>
    expect(() => iframeUrl(raw, window.location.origin, 'abcdefghijklmnop')).toThrow(),
  )
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
