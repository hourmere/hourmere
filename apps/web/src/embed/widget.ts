import { embedOrigin, publicBookingPath } from '@hourmere/core/embed'
import { explicitLanguage, type InterfaceLanguage } from '@hourmere/core/language'
import { randomHex } from '../random.ts'
import { widgetLanguage, widgetMessages } from './language.ts'

export interface InlineOptions {
  element: HTMLElement
  url: string
  height?: number
  language?: InterfaceLanguage
}
export interface EmbedHandle {
  iframe: HTMLIFrameElement
  destroy: () => void
}
const mounted = new WeakMap<HTMLElement, EmbedHandle>()
let popup: { dialog: HTMLDialogElement; handle: EmbedHandle; previous: Element | null } | undefined

/** Validated booking URLs cannot turn this helper into a general-purpose iframe loader. */
export function iframeUrl(
  raw: string,
  parentOrigin: string,
  id: string,
  language?: InterfaceLanguage,
): URL {
  if (typeof raw !== 'string' || raw.length > 4096) throw new Error('Invalid Hourmere booking URL')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Use a full Hourmere booking URL')
  }
  const path = publicBookingPath(url.pathname)
  if (
    !path ||
    !embedOrigin(url.origin) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !embedOrigin(parentOrigin)
  )
    throw new Error('Invalid Hourmere booking URL or parent origin')
  const query = new URLSearchParams({ parentOrigin, embedId: id })
  if (language !== undefined) query.set('language', widgetLanguage(language))
  return new URL(`/embed${path}?${query}`, url.origin)
}

export function initInline({ element, url, height = 720, language }: InlineOptions): EmbedHandle {
  if (
    !(element instanceof HTMLElement) ||
    element.ownerDocument !== document ||
    !Number.isInteger(height) ||
    height < 240 ||
    height > 2000
  )
    throw new Error('Invalid Hourmere embed container or height')
  const selectedLanguage = widgetLanguage(language)
  const id = randomHex(16),
    target = iframeUrl(url, window.location.origin, id, selectedLanguage)
  mounted.get(element)?.destroy()
  const iframe = document.createElement('iframe')
  iframe.title = widgetMessages(selectedLanguage).iframe
  iframe.referrerPolicy = 'no-referrer'
  iframe.setAttribute('allow', 'clipboard-write')
  iframe.setAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox',
  )
  iframe.setAttribute('loading', 'lazy')
  Object.assign(iframe.style, {
    width: '100%',
    height: `${height}px`,
    border: '0',
    display: 'block',
  })
  iframe.src = target.href
  let destroyed = false
  const receive = (event: MessageEvent<unknown>) => {
    if (
      destroyed ||
      event.origin !== target.origin ||
      event.source !== iframe.contentWindow ||
      !event.data ||
      typeof event.data !== 'object' ||
      Array.isArray(event.data)
    )
      return
    const data = event.data as Record<string, unknown>
    if (data.id !== id) return
    if (
      data.type === 'hourmere:resize' &&
      typeof data.height === 'number' &&
      Number.isFinite(data.height) &&
      Number.isInteger(data.height) &&
      data.height >= 240 &&
      data.height <= 2000
    )
      iframe.style.height = `${data.height}px`
    if (data.type === 'hourmere:close' && popup?.handle.iframe === iframe) closePopup()
    if (data.type === 'hourmere:booked')
      element.dispatchEvent(new CustomEvent('hourmere:booking-completed'))
  }
  const handle: EmbedHandle = {
    iframe,
    destroy() {
      if (destroyed) return
      destroyed = true
      window.removeEventListener('message', receive)
      iframe.remove()
      if (mounted.get(element) === handle) mounted.delete(element)
    },
  }
  window.addEventListener('message', receive)
  element.append(iframe)
  mounted.set(element, handle)
  return handle
}
export function destroyInline(element: HTMLElement) {
  mounted.get(element)?.destroy()
}
export function closePopup() {
  const current = popup
  if (!current) return
  popup = undefined
  current.handle.destroy()
  current.dialog.close()
  current.dialog.remove()
  if (current.previous instanceof HTMLElement && current.previous.isConnected)
    current.previous.focus()
}
export function openPopup({ url, language }: { url: string; language?: InterfaceLanguage }) {
  const selectedLanguage = widgetLanguage(language),
    text = widgetMessages(selectedLanguage)
  // Validate before closing an existing usable dialog or modifying the host document.
  iframeUrl(url, window.location.origin, randomHex(16))
  closePopup()
  const previous = document.activeElement,
    dialog = document.createElement('dialog'),
    title = document.createElement('h2'),
    close = document.createElement('button'),
    holder = document.createElement('div')
  title.id = `hourmere-title-${randomHex(16)}`
  title.textContent = text.title
  dialog.setAttribute('aria-labelledby', title.id)
  Object.assign(dialog.style, {
    width: 'min(1000px, calc(100vw - 24px))',
    maxWidth: '1000px',
    maxHeight: '90vh',
    padding: '16px',
    border: '1px solid #888',
    borderRadius: '12px',
    background: '#fff',
    color: '#111',
    overflow: 'auto',
    boxSizing: 'border-box',
  })
  Object.assign(title.style, { font: '600 18px system-ui', margin: '0 0 12px' })
  close.type = 'button'
  close.textContent = text.close
  close.setAttribute('aria-label', text.closeLabel)
  Object.assign(close.style, {
    font: 'inherit',
    marginBottom: '12px',
    padding: '8px 16px',
    cursor: 'pointer',
  })
  // A retiring dialog's queued events and stale handle cannot close its replacement.
  const closeCurrent = () => {
    if (popup?.dialog === dialog) closePopup()
  }
  close.addEventListener('click', closeCurrent)
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    closeCurrent()
  })
  dialog.addEventListener('close', closeCurrent)
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeCurrent()
  })
  dialog.append(title, close, holder)
  document.body.append(dialog)
  try {
    const handle = initInline({ element: holder, url, language: selectedLanguage })
    handle.iframe.removeAttribute('loading')
    popup = { dialog, handle, previous }
    dialog.showModal()
    close.focus()
    return { close: closeCurrent }
  } catch (error) {
    popup?.handle.destroy()
    popup = undefined
    dialog.remove()
    throw error
  }
}

const buttons = new WeakSet<HTMLElement>()
function errorMessage(element: HTMLElement, language?: InterfaceLanguage) {
  const status = document.createElement('p')
  status.setAttribute('role', 'alert')
  status.textContent = widgetMessages(widgetLanguage(language)).failure
  element.append(status)
}
export function init() {
  for (const element of document.querySelectorAll<HTMLElement>('[data-hourmere-inline]')) {
    if (mounted.has(element)) continue
    try {
      initInline({
        element,
        url: element.getAttribute('data-hourmere-url') ?? '',
        language: widgetLanguage(element.getAttribute('data-hourmere-language') ?? undefined),
      })
    } catch {
      errorMessage(element, explicitLanguage(element.getAttribute('data-hourmere-language')))
    }
  }
  for (const element of document.querySelectorAll<HTMLElement>('[data-hourmere-popup]')) {
    if (buttons.has(element)) continue
    buttons.add(element)
    element.addEventListener('click', (event) => {
      event.preventDefault()
      element.focus()
      try {
        openPopup({
          url: element.getAttribute('data-hourmere-url') ?? '',
          language: widgetLanguage(element.getAttribute('data-hourmere-language') ?? undefined),
        })
      } catch {
        errorMessage(
          element.parentElement ?? element,
          explicitLanguage(element.getAttribute('data-hourmere-language')),
        )
      }
    })
  }
}
export const widget = {
  version: 1,
  init,
  initInline,
  destroyInline,
  openPopup,
  closePopup,
} as const
declare global {
  interface Window {
    Hourmere?: typeof widget
  }
}
export function install() {
  if (window.Hourmere) return
  window.Hourmere = widget
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init, { once: true })
  else init()
}
