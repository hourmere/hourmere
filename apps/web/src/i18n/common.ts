import { type CatalogueSource, createCatalogueLoader } from './catalogue-loader.ts'
import { common } from './catalogues/en/common.ts'
import { type Catalog, registerCatalog } from './catalogues.ts'

registerCatalog(common, 'en')

// Keep the public graph independent of the session catalogues.
export const commonCatalogue = createCatalogueLoader(
  import.meta.env.PROD && !import.meta.env.SSR
    ? import.meta.glob<CatalogueSource>(
        ['./catalogues/*/common.ts', '!./catalogues/en/common.ts'],
        { eager: true, import: 'default', query: '?url' },
      )
    : import.meta.glob<Catalog>(['./catalogues/*/common.ts', '!./catalogues/en/common.ts'], {
        import: 'common',
      }),
  'common',
)
