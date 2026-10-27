import { readdirSync, readFileSync } from 'node:fs'
import { type InterfaceLanguage, localeFallbacks } from '@hourmere/core/language'
import english from './catalogues/en.json' with { type: 'json' }
import { formatChineseTemplate } from './text.ts'

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

/** Resolve each key separately; partial translations retain the complete English message. */
export function mailMessage(
  language: InterfaceLanguage,
  key: MailKey,
  values: Record<string, string> = {},
): string {
  for (const candidate of localeFallbacks(language)) {
    const template = mailCatalogues[candidate]?.[key]
    if (typeof template !== 'string' || template === '') continue
    if (candidate === 'zh-CN') return formatChineseTemplate(template, values)
    return template.replace(
      /\{(\w+)\}/g,
      (placeholder, name: string) => values[name] ?? placeholder,
    )
  }
  // English is statically imported as well as discovered, and is always the final fallback.
  return english[key].replace(
    /\{(\w+)\}/g,
    (placeholder, name: string) => values[name] ?? placeholder,
  )
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
