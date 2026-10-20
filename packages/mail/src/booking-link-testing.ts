import { escapeHtml } from './text.ts'

// Assertions for Hourmere's generated test fixtures, not parsers for untrusted mail.
// Compare complete tokens/fields so an attacker URL containing a fixture URL cannot pass.
export function textHasUrl(text: string, expected: string): boolean {
  return text.split(/[\s：]+/u).some((token) => token === expected)
}

export function htmlHasLink(html: string, expected: string): boolean {
  return [...html.matchAll(/<a href="([^"]*)"/g)].some((match) => match[1] === escapeHtml(expected))
}

export function icsHasLocation(ics: string, expected: string): boolean {
  return ics
    .replace(/\r?\n[ \t]/g, '')
    .split(/\r?\n/)
    .some((line) => line === `LOCATION:${expected}`)
}
