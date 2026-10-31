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
let popup:
  | {
      dialog: HTMLDialogElement
      host: HTMLElement
      handle: EmbedHandle
      previous: Element | null
      restoreScroll: () => void
    }
  | undefined

// Inside the shadow root, host-page resets cannot restyle the dialog or its controls.
const popupStyles = `
  dialog {
    all: revert;
    color-scheme: light dark;
    font: 16px/1.5 system-ui, sans-serif;
    text-align: start;
    direction: ltr;
    color: CanvasText;
    background: Canvas;
    border: 1px solid GrayText;
    border-radius: 12px;
    box-sizing: border-box;
    width: min(1000px, calc(100vw - 24px));
    max-width: 1000px;
    max-height: 90vh;
    max-height: 90dvh;
    margin: auto;
    padding: 16px;
    overflow: hidden;
    overscroll-behavior: contain;
  }
  dialog[open] { display: flex; flex-direction: column; gap: 12px; }
  dialog::backdrop { background: rgb(0 0 0 / .5); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h2 { font: 600 18px/1.5 system-ui, sans-serif; margin: 0; }
  button {
    appearance: none;
    flex: none;
    width: 44px;
    height: 44px;
    box-sizing: border-box;
    display: grid;
    place-items: center;
    margin: 0;
    padding: 0;
    border: 1px solid GrayText;
    border-radius: 8px;
    background: Canvas;
    color: CanvasText;
    font: 28px/1 system-ui, sans-serif;
    cursor: pointer;
  }
  button:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
  .content { min-height: 0; overflow: auto; overscroll-behavior: contain; }
  @media (max-width: 480px), (max-height: 480px) {
    dialog {
      width: 100vw;
      max-width: 100vw;
      height: 100vh;
      height: 100dvh;
      max-height: 100vh;
      max-height: 100dvh;
      margin: 0;
      padding: 0;
      border: 0;
      border-radius: 0;
    }
    header { padding: 8px 12px 0; }
    .content { flex: 1; }
  }
`

function lockBackgroundScroll() {
  const properties = [
    'overflow',
    'overflow-x',
    'overflow-y',
    'scrollbar-gutter',
    'padding',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
  ] as const
  const originals = [document.documentElement, document.body].map((element) => ({
    element,
    values: properties.map((name) => ({
      name,
      value: element.style.getPropertyValue(name),
      priority: element.style.getPropertyPriority(name),
    })),
  }))
  const root = document.documentElement
  const scrollbarWidth = Math.max(0, window.innerWidth - root.clientWidth)
  if (
    scrollbarWidth > 0 &&
    typeof CSS !== 'undefined' &&
    CSS.supports?.('scrollbar-gutter', 'stable')
  ) {
    // Retain a host's existing both-edges policy without adding padding as well.
    const gutter = getComputedStyle(root).getPropertyValue('scrollbar-gutter')
    root.style.setProperty(
      'scrollbar-gutter',
      gutter.includes('stable') ? gutter : 'stable',
      'important',
    )
  } else if (scrollbarWidth > 0) {
    // Safari before 18.2 has no stable gutter. Replace the disappearing scrollbar
    // with padding, keeping any padding the host page already has.
    const padding = Number.parseFloat(getComputedStyle(document.body).paddingRight) || 0
    document.body.style.setProperty('padding-right', `${padding + scrollbarWidth}px`, 'important')
  }
  for (const { element } of originals) element.style.setProperty('overflow', 'hidden', 'important')
  return () => {
    for (const { element, values } of originals) {
      for (const name of properties) element.style.removeProperty(name)
      for (const { name, value, priority } of values)
        if (value) element.style.setProperty(name, value, priority)
    }
  }
}

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
  let id = randomHex(16)
  const target = iframeUrl(url, window.location.origin, id, selectedLanguage)
  target.searchParams.set('parentRedirect', 'disabled')
  mounted.get(element)?.destroy()
  const iframe = document.createElement('iframe')
  iframe.title = widgetMessages(selectedLanguage).iframe
  iframe.referrerPolicy = 'no-referrer'
  iframe.setAttribute('allow', 'clipboard-write')
  const sandbox =
    'allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox'
  iframe.setAttribute('sandbox', sandbox)
  iframe.setAttribute('loading', 'lazy')
  iframe.inert = true
  iframe.tabIndex = -1
  Object.assign(iframe.style, {
    width: '100%',
    height: `${height}px`,
    border: '0',
    display: 'block',
    // Keep loading/error text visible and lazy loading eligible, while blocking input
    // until saved settings are known and a possible reload can no longer discard it.
    pointerEvents: 'none',
  })
  iframe.src = target.href
  let destroyed = false
  let ready = false
  let parentNavigation = false
  let downgraded = false
  const reload = () => {
    // Window identity survives navigation. Rotate the correlation ID so queued messages
    // from the retiring document cannot enable input in the new frame before it is ready.
    id = randomHex(16)
    target.searchParams.set('embedId', id)
    iframe.src = target.href
  }
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
    if (data.type === 'hourmere:ready') {
      if (ready || Object.keys(data).length !== 3 || typeof data.allowEmbedParent !== 'boolean')
        return
      if (data.allowEmbedParent && !parentNavigation && !downgraded) {
        parentNavigation = true
        iframe.setAttribute('sandbox', `${sandbox} allow-top-navigation-by-user-activation`)
        target.searchParams.set('parentRedirect', 'enabled')
        // Sandbox changes affect the next document, not the active one. Reload only this
        // validated URL before enabling input; ready messages never supply a URL.
        reload()
        return
      }
      if (!data.allowEmbedParent && parentNavigation) {
        parentNavigation = false
        downgraded = true
        iframe.setAttribute('sandbox', sandbox)
        target.searchParams.set('parentRedirect', 'disabled')
        // A setting changed during the reload: activate the restrictive sandbox once.
        // Further upgrades are ignored so changing settings cannot cause a reload loop.
        reload()
        return
      }
      ready = true
      iframe.inert = false
      iframe.removeAttribute('tabindex')
      iframe.style.removeProperty('pointer-events')
      return
    }
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
    if (data.type === 'hourmere:booked') {
      const completionTarget =
        popup?.handle.iframe === iframe
          ? popup.previous instanceof HTMLElement && popup.previous.isConnected
            ? popup.previous
            : document
          : element
      completionTarget.dispatchEvent(
        new CustomEvent('hourmere:booking-completed', { bubbles: true }),
      )
    }
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
  try {
    current.dialog.close()
  } finally {
    current.restoreScroll()
    current.host.remove()
    if (current.previous instanceof HTMLElement && current.previous.isConnected)
      current.previous.focus()
  }
}
export function openPopup({ url, language }: { url: string; language?: InterfaceLanguage }) {
  const selectedLanguage = widgetLanguage(language),
    text = widgetMessages(selectedLanguage)
  // Validate before closing an existing usable dialog or modifying the host document.
  iframeUrl(url, window.location.origin, randomHex(16))
  closePopup()
  const previous = document.activeElement,
    host = document.createElement('div'),
    root = host.attachShadow({ mode: 'open' }),
    dialog = document.createElement('dialog'),
    header = document.createElement('header'),
    title = document.createElement('h2'),
    close = document.createElement('button'),
    holder = document.createElement('div')
  host.setAttribute('data-hourmere-popup-host', '')
  host.style.setProperty('all', 'initial', 'important')
  host.style.setProperty('display', 'contents', 'important')
  // Constructed sheets also work when a host CSP disallows inline <style> elements.
  if ('adoptedStyleSheets' in root && typeof CSSStyleSheet.prototype.replaceSync === 'function') {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(popupStyles)
    root.adoptedStyleSheets = [sheet]
  } else {
    const style = document.createElement('style')
    style.textContent = popupStyles
    root.append(style)
  }
  title.id = `hourmere-title-${randomHex(16)}`
  title.textContent = text.title
  dialog.lang = selectedLanguage
  dialog.setAttribute('aria-labelledby', title.id)
  close.type = 'button'
  close.textContent = '×'
  close.setAttribute('aria-label', text.closeLabel)
  holder.className = 'content'
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
    if (event.target !== dialog) return
    const rect = dialog.getBoundingClientRect()
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      closeCurrent()
  })
  header.append(title, close)
  dialog.append(header, holder)
  root.append(dialog)
  document.body.append(host)
  try {
    const handle = initInline({ element: holder, url, language: selectedLanguage })
    handle.iframe.removeAttribute('loading')
    popup = { dialog, host, handle, previous, restoreScroll: lockBackgroundScroll() }
    dialog.showModal()
    close.focus()
    return { close: closeCurrent }
  } catch (error) {
    if (popup?.dialog === dialog) {
      popup.handle.destroy()
      popup.restoreScroll()
      popup = undefined
    }
    host.remove()
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    throw error
  }
}

const buttons = new WeakSet<HTMLElement>()
const errors = new WeakMap<HTMLElement, HTMLParagraphElement>()
function clearError(element: HTMLElement) {
  errors.get(element)?.remove()
  errors.delete(element)
}
function errorMessage(
  element: HTMLElement,
  language?: InterfaceLanguage,
  container: HTMLElement = element,
) {
  let status = errors.get(element)
  if (!status) {
    status = document.createElement('p')
    status.setAttribute('role', 'alert')
    errors.set(element, status)
  }
  status.textContent = widgetMessages(widgetLanguage(language)).failure
  container.append(status)
}
export function init() {
  for (const element of document.querySelectorAll<HTMLElement>('[data-hourmere-inline]')) {
    if (mounted.has(element)) continue
    try {
      initInline({
        element,
        url: element.getAttribute('data-hourmere-url') ?? '',
        language: widgetLanguage(element.getAttribute('data-hourmere-language') ?? undefined),
        height: element.hasAttribute('data-hourmere-height')
          ? Number(element.getAttribute('data-hourmere-height'))
          : undefined,
      })
      clearError(element)
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
        clearError(element)
      } catch {
        errorMessage(
          element,
          explicitLanguage(element.getAttribute('data-hourmere-language')),
          element.parentElement ?? element,
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
