import { type CatalogueSource, createCatalogueLoader } from './catalogue-loader.ts'
import { admin } from './catalogues/en/admin.ts'
import { type Catalog, registerCatalog } from './catalogues.ts'

registerCatalog(admin, 'en')

// Only routes that already use the admin catalogue import its loader.
export const adminCatalogue = createCatalogueLoader(
  import.meta.env.PROD && !import.meta.env.SSR
    ? import.meta.glob<CatalogueSource>(['./catalogues/*/admin.ts', '!./catalogues/en/admin.ts'], {
        eager: true,
        import: 'default',
        query: '?url',
      })
    : import.meta.glob<Catalog>(['./catalogues/*/admin.ts', '!./catalogues/en/admin.ts'], {
        import: 'admin',
      }),
  'admin',
)
