import { embedOrigin, publicBookingPath } from './embed.ts'

export interface EmbedSnippetOptions {
  publicUrl: string
  bookingPath: string
  mode: 'inline' | 'popup'
  height?: number
  buttonLabel?: string
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Declarative widget markup for a saved reusable booking address, matching the docs. */
export function embedSnippet({
  publicUrl,
  bookingPath,
  mode,
  height = 720,
  buttonLabel = 'Book a meeting',
}: EmbedSnippetOptions): string {
  const origin = embedOrigin(publicUrl)
  const path = publicBookingPath(bookingPath)
  if (!origin || !path) throw new Error('Invalid Hourmere public booking address')
  if (mode !== 'inline' && mode !== 'popup') throw new Error('Invalid Hourmere embed mode')
  if (mode === 'popup' && !buttonLabel.trim())
    throw new Error('Invalid Hourmere popup button label')
  if (!Number.isInteger(height) || height < 240 || height > 2000)
    throw new Error('Invalid Hourmere embed height')
  const url = escapeHtml(`${origin}${path}`)
  const script = `<script src="${escapeHtml(origin)}/hourmere-embed.js" defer></script>`
  if (mode === 'inline')
    return `<div data-hourmere-inline
     data-hourmere-url="${url}"
     data-hourmere-height="${height}"></div>
${script}`
  return `<button type="button" data-hourmere-popup
        data-hourmere-url="${url}">${escapeHtml(buttonLabel)}</button>
${script}`
}
