import type { InterfaceLanguage } from '@hourmere/core/language'
import { escapeHtml } from './text.ts'

export const emailWrapStyle = 'overflow-wrap: anywhere; word-break: break-word;'
export const emailLinkStyle = `color: #1f4fd8; ${emailWrapStyle}`

const fontFamily =
  '-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",Roboto,Helvetica,Arial,sans-serif'
const fontStyle = `font-family: ${escapeHtml(fontFamily)};`

/** The content is prepared HTML; titles and button values are escaped by their helpers. */
export function emailLayout(language: InterfaceLanguage, title: string, content: string): string {
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(title)}</title>
<style>body, table, td { font-family: ${fontFamily}; } :root { color-scheme: light; supported-color-schemes: light; }</style>
</head>
<body bgcolor="#ffffff" style="margin: 0; padding: 0; background-color: #ffffff; color: #111; ${fontStyle} font-size: 16px; line-height: 1.5;">
<table role="presentation" width="600" align="center" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; ${fontStyle}">
<tr><td style="padding: 24px; ${fontStyle} ${emailWrapStyle}">
<p style="margin: 0 0 24px; color: #1f4fd8; font-size: 20px; font-weight: 700;">Hourmere</p>
${content}
</td></tr>
</table>
</body>
</html>
`
}

/** Table backgrounds and Outlook padding preserve the button when anchor CSS is limited. */
export function emailButton(label: string, url: string, secondary = false): string {
  const background = secondary ? '#ffffff' : '#1f4fd8'
  const color = secondary ? '#1f4fd8' : '#ffffff'
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 16px 0; max-width: 100%; ${fontStyle}"><tr><td bgcolor="${background}" style="padding: 0; mso-padding-alt: 12px 18px; background-color: ${background}; border: 1px solid #1f4fd8; border-radius: 6px; text-align: center; ${fontStyle}"><a href="${escapeHtml(url)}" style="display: block; padding: 12px 18px; line-height: 20px; min-height: 20px; color: ${color}; text-decoration: none; ${emailWrapStyle}">${escapeHtml(label)}</a></td></tr></table>`
}
