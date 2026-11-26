import { readdirSync, readFileSync } from 'node:fs'
import {
  type InterfaceLanguage,
  localeFallbacks,
  spaceCjkBoundaries,
} from '@hourmere/core/language'
import english from './catalogues/en.json' with { type: 'json' }
import { type EmailContent, emailText, formatChineseTemplate } from './text.ts'

export type MailKey = keyof typeof english
export type MailCatalogue = Partial<Record<MailKey, string>>

// Node runs these source files directly in development and in the production image.
// Discover catalogue files once, so a new registered locale needs no loader changes.
const directory = new URL('./catalogues/', import.meta.url)
export const mailCatalogues: Readonly<Record<string, MailCatalogue>> = Object.fromEntries(
  readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .map((file) => [
      file.slice(0, -5),
      JSON.parse(readFileSync(new URL(file, directory), 'utf8')) as MailCatalogue,
    ]),
)

/** Choose one language for all parts of a message. */
export function mailMessageLocale(
  language: InterfaceLanguage,
  keys: readonly MailKey[],
): InterfaceLanguage {
  return (
    localeFallbacks(language).find((candidate) =>
      keys.every((key) => {
        const template = mailCatalogues[candidate]?.[key]
        return typeof template === 'string' && template !== ''
      }),
    ) ?? 'en'
  )
}

function mailTemplate(language: InterfaceLanguage, key: MailKey) {
  const candidate = mailMessageLocale(language, [key])
  // English is statically imported as well as discovered, and is always the final fallback.
  const translation = mailCatalogues[candidate]?.[key]
  const template =
    typeof translation === 'string' && translation !== '' ? translation : english[key]
  return { candidate, template }
}

/** Resolve each key separately; partial translations retain the complete English message. */
export function mailMessage(
  language: InterfaceLanguage,
  key: MailKey,
  values: Record<string, string> = {},
): string {
  const { candidate, template } = mailTemplate(language, key)
  if (candidate === 'zh-CN') return formatChineseTemplate(template, values)
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => values[name] ?? placeholder)
}

/** Interpolate plain text and prepared content into parallel MIME alternatives. */
export function mailContent(
  language: InterfaceLanguage,
  key: MailKey,
  values: Record<string, string | EmailContent> = {},
): EmailContent {
  const { candidate, template } = mailTemplate(language, key)
  let end = 0
  let html = ''
  let text = ''
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    const [placeholder, name] = match
    const before = template.slice(end, match.index)
    end = match.index + placeholder.length
    const value = (name && Object.hasOwn(values, name) ? values[name] : undefined) ?? placeholder
    const plain = typeof value === 'string' ? value : value.text
    const valueHtml = typeof value === 'string' ? emailText(value, language) : value.html
    const spaced =
      candidate === 'zh-CN' ? spaceCjkBoundaries(before, plain, template.slice(end)) : plain
    const offset = spaced.indexOf(plain)
    html +=
      emailText(before, language) +
      spaced.slice(0, offset) +
      valueHtml +
      spaced.slice(offset + plain.length)
    text += before + spaced
  }
  const after = template.slice(end)
  return { text: text + after, html: html + emailText(after, language) }
}

/** Validate only translated keys: incomplete future catalogues are supported at runtime. */
export function mailCatalogueProblems(catalogue: Readonly<Record<string, unknown>>): string[] {
  const problems: string[] = []
  const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
  for (const [key, value] of Object.entries(catalogue)) {
    if (!Object.hasOwn(english, key)) {
      problems.push(`${key}: unknown key`)
      continue
    }
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`${key}: expected nonempty text`)
      continue
    }
    const expected = english[key as MailKey]
    if (
      /[{}]/.test(value.replace(/\{\w+\}/g, '')) ||
      JSON.stringify(placeholders(value)) !== JSON.stringify(placeholders(expected))
    ) {
      problems.push(`${key}: malformed or mismatched placeholders`)
    }
  }
  return problems
}
