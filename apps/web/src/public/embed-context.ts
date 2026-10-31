import { EMBED_ID, embedOrigin } from '@hourmere/core/embed'
import { explicitLanguage } from '@hourmere/core/language'
import { createContext, useContext } from 'react'

export const EmbeddedContext = createContext(false)
export const useEmbedded = () => useContext(EmbeddedContext)
export function embedMessageContext() {
  const q = new URLSearchParams(window.location.search),
    origin = embedOrigin(q.get('parentOrigin') ?? ''),
    id = q.get('embedId')
  if (
    !origin ||
    !id ||
    !EMBED_ID.test(id) ||
    q.getAll('parentOrigin').length !== 1 ||
    q.getAll('embedId').length !== 1 ||
    q.getAll('language').length > 1 ||
    (q.has('language') && !explicitLanguage(q.get('language'))) ||
    window.parent === window
  )
    return undefined
  return { origin, id }
}
/** Completion is deliberately data-free: no identifiers, attendees, answers or tokens. */
export function notifyEmbedBooked() {
  const target = embedMessageContext()
  if (target) window.parent.postMessage({ type: 'hourmere:booked', id: target.id }, target.origin)
}
/** Only the saved capability is disclosed; the continuation target stays in the frame. */
export function notifyEmbedReady(allowEmbedParent: boolean) {
  const target = embedMessageContext()
  if (target)
    window.parent.postMessage(
      { type: 'hourmere:ready', id: target.id, allowEmbedParent },
      target.origin,
    )
}
/** The widget marker can only narrow saved permission, including after a policy race. */
export function embedParentRedirectAllowed() {
  const values = new URLSearchParams(window.location.search).getAll('parentRedirect')
  // Manual iframe integrations have no widget marker and own their sandbox configuration.
  return values.length === 0 || (values.length === 1 && values[0] === 'enabled')
}
