import { readFileSync } from 'node:fs'
import {
  type InterfaceLanguage,
  interfaceLanguages,
  localeFallbacks,
  registeredLocales,
} from '@hourmere/core/language'
import english from './catalogues/en.json' with { type: 'json' }

type ConfirmationWords = typeof english

export const confirmationLocales = registeredLocales.filter(({ code }) =>
  interfaceLanguages('admin').includes(code),
)

const catalogues: Record<string, Partial<ConfirmationWords>> = { en: english }
for (const { code } of confirmationLocales) {
  if (code === 'en') continue
  try {
    const catalogue: unknown = JSON.parse(
      readFileSync(new URL(`./catalogues/${code}.json`, import.meta.url), 'utf8'),
    )
    if (
      !catalogue ||
      typeof catalogue !== 'object' ||
      Array.isArray(catalogue) ||
      Object.entries(catalogue).some(
        ([key, value]) =>
          !Object.hasOwn(english, key) || typeof value !== 'string' || !value || /[{}]/.test(value),
      )
    )
      throw new Error(`Malformed confirmation catalogue: ${code}`)
    catalogues[code] = catalogue
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Resolve each word independently; incomplete catalogues always retain English copy. */
export const confirmationCatalogues = Object.fromEntries(
  confirmationLocales.map(({ code }) => [
    code,
    Object.fromEntries(
      Object.entries(english).map(([key, value]) => [
        key,
        localeFallbacks(code)
          .map((fallback) => catalogues[fallback]?.[key as keyof ConfirmationWords])
          .find((translation) => translation !== undefined) ?? value,
      ]),
    ),
  ]),
) as Record<InterfaceLanguage, ConfirmationWords>
