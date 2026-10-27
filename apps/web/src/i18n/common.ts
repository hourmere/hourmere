import type { Catalog } from './catalogues.ts'

// The public graph includes common messages only. Admin catalogues stay in the session chunk.
export const commonCatalogues = import.meta.glob<Catalog>('./catalogues/*/common.ts', {
  eager: true,
  import: 'common',
})
export { common } from './catalogues/zh-CN/common.ts'
