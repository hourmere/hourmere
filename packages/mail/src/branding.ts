import { brandPalette } from '@hourmere/core/brand-contrast'
import type { MailMessage } from './index.ts'
import { escapeHtml } from './text.ts'

export interface EmailBranding {
  name: string
  primaryColor: string | null
  logoDataUrl: string | null
}

/** Theme trusted template styles only. Text, capabilities and calendar parts are unchanged. */
export function brandEmail(message: MailMessage, brand?: EmailBranding): MailMessage {
  if (!brand || !message.html) return message
  const palette = brandPalette(brand.primaryColor)?.light
  let html = message.html
  if (palette) {
    html = html
      .replace(/style="([^"]*)"/g, (_attribute, style: string) => {
        let themed = style.replace(/(?<![-\w])color: #1f4fd8;/g, `color: ${palette.link};`)
        // Primary buttons have a white foreground; ordinary white surfaces stay white.
        if (style.includes('display: block; padding: 12px 18px;')) {
          themed = themed.replace('color: #ffffff;', `color: ${palette.accentText};`)
        }
        themed = themed.replaceAll(
          'background-color: #1f4fd8;',
          `background-color: ${palette.accent};`,
        )
        themed = themed.replaceAll(
          'border: 1px solid #1f4fd8;',
          `border: 1px solid ${palette.focus};`,
        )
        return `style="${themed}"`
      })
      .replaceAll('bgcolor="#1f4fd8"', `bgcolor="${palette.accent}"`)
  }
  const encoded = brand.logoDataUrl?.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/)?.[1]
  const png = encoded ? Buffer.from(encoded, 'base64') : undefined
  // Uploaded images are normalized PNGs. Keep this boundary defensive for stale/corrupt data.
  if (
    !png ||
    png.length < 24 ||
    png.length > 64 * 1024 ||
    png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
  ) {
    return { ...message, html }
  }
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  if (!width || !height || width > 512 || height > 512) return { ...message, html }
  const scale = Math.min(1, 160 / width, 64 / height)
  const image = `<img src="cid:organization-logo@hourmere" alt="${escapeHtml(brand.name)}" width="${Math.max(1, Math.round(width * scale))}" height="${Math.max(1, Math.round(height * scale))}" style="display: block; max-width: 160px; max-height: 64px; margin: 0 0 24px;">`
  // Every ordinary booking template has this header. Minimal group notices have no wrapper.
  html = html.includes('>Hourmere</p>')
    ? html.replace(/<p style="[^"]*">Hourmere<\/p>/, (header) => `${image}${header}`)
    : `${image}${html}`
  return {
    ...message,
    html,
    attachments: [
      ...(message.attachments ?? []),
      {
        filename: 'organization-logo.png',
        contentType: 'image/png',
        content: encoded as string,
        encoding: 'base64',
        cid: 'organization-logo@hourmere',
      },
    ],
  }
}
