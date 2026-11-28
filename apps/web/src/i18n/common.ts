import { chunkSources, createCatalogueLoader } from './catalogue-loader.ts'
import { common } from './catalogues/en/common.ts'
import { type Catalog, registerCatalog } from './catalogues.ts'

registerCatalog(common, 'en')

// Keep the public graph independent of the session catalogues.
export const commonCatalogue = createCatalogueLoader(
  import.meta.env.PROD && !import.meta.env.SSR
    ? chunkSources(
        import.meta.glob<string>(['./catalogues/*/common.ts', '!./catalogues/en/common.ts'], {
          eager: true,
          import: 'default',
          query: '?url',
        }),
        'common',
      )
    : import.meta.glob<Catalog>(['./catalogues/*/common.ts', '!./catalogues/en/common.ts'], {
        import: 'common',
      }),
  'common',
)
