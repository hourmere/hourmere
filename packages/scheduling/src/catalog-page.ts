import { DomainError } from './errors.ts'
import { isUuid } from './internal.ts'

export const DEFAULT_CATALOG_PAGE_SIZE = 20
export const MAX_CATALOG_PAGE_SIZE = 100

export interface CatalogPageInput {
  limit?: number | undefined
  /** Exclusive id from the previous page; keep the same caller and acting organization. */
  after?: string | undefined
}

export interface CatalogPage<T> {
  data: T[]
  nextAfter: string | null
}

export function checkedCatalogPage(input: CatalogPageInput) {
  const limit = input.limit ?? DEFAULT_CATALOG_PAGE_SIZE
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CATALOG_PAGE_SIZE) {
    throw new DomainError('invalid', 'invalid_limit', `limit must be 1 to ${MAX_CATALOG_PAGE_SIZE}`)
  }
  if (input.after !== undefined && !isUuid(input.after)) {
    throw new DomainError(
      'invalid',
      'invalid_cursor',
      'after must be a UUID from the previous page',
    )
  }
  return { limit, after: input.after }
}

/** Queries fetch at most limit + 1 rows; expose only the requested page. */
export function catalogPage<T extends { id: string }>(rows: T[], limit: number): CatalogPage<T> {
  const data = rows.slice(0, limit)
  return { data, nextAfter: rows.length > limit ? (data.at(-1)?.id ?? null) : null }
}
