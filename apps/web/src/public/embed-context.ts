import { EMBED_ID, embedOrigin } from '@hourmere/core/embed'
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
