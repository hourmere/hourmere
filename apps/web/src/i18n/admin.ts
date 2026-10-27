import { type Catalog, registerCatalogues } from './catalogues.ts'

// Only the lazy session graph imports this module.
registerCatalogues(
  import.meta.glob<Catalog>('./catalogues/*/admin.ts', { eager: true, import: 'admin' }),
)

export { admin } from './catalogues/zh-CN/admin.ts'
