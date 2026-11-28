import { explicitLanguage } from '@hourmere/core/language'
import { primeWidgetCatalogue } from '../embed/language.ts'
import { adminCatalogue } from './admin.ts'
import type { Catalog } from './catalogues.ts'
import { commonCatalogue } from './common.ts'

export const commonCatalogues = import.meta.glob<Catalog>('./catalogues/*/common.ts', {
  eager: true,
  import: 'common',
})

export function primeTestCatalogues() {
  const groups = [
    [commonCatalogue.prime, commonCatalogues],
    [
      adminCatalogue.prime,
      import.meta.glob<Catalog>('./catalogues/*/admin.ts', { eager: true, import: 'admin' }),
    ],
    [
      primeWidgetCatalogue,
      import.meta.glob<Catalog>('./catalogues/*/widget.ts', { eager: true, import: 'widget' }),
    ],
  ] as const
  for (const [prime, catalogues] of groups) {
    for (const [path, catalogue] of Object.entries(catalogues)) {
      const locale = explicitLanguage(path.split('/')[2])
      if (locale && locale !== 'en') prime(locale, catalogue)
    }
  }
}
