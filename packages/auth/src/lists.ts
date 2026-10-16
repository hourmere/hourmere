import type { Db } from '@hourmere/db'
import { APIError, getSessionFromCtx } from 'better-auth/api'
import type { AuthMiddlewareContext } from './api-keys.ts'
import { isMember, isUuid } from './organizations.ts'

/**
 * What list endpoints may sort and filter by. Better Auth hands sortBy / filterField to its
 * database adapter as column names and filterValue to Postgres as is, so anything else
 * would be a 500 with the request's text in the error. Filters are exact matches only
 * (eq, ne, in, not_in): the other operators make no sense on ids and would need typed
 * operands, and exact matches let the empty-list workaround below agree with Better Auth.
 */
const LISTS: Record<string, { sortable: string[]; filterable: string[]; uuids: string[] }> = {
  '/organization/list-members': {
    sortable: ['id', 'organizationId', 'userId', 'role', 'createdAt'],
    filterable: ['id', 'organizationId', 'userId', 'role'],
    uuids: ['id', 'organizationId', 'userId'],
  },
  '/api-key/list': {
    sortable: ['name', 'start', 'prefix', 'enabled', 'expiresAt', 'createdAt', 'updatedAt'],
    filterable: [],
    uuids: [],
  },
}

const OPERATORS = ['eq', 'ne', 'in', 'not_in'] as const
type Operator = (typeof OPERATORS)[number]

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const bad = (code: string, message: string) => new APIError('BAD_REQUEST', { code, message })

interface Filter {
  field: 'id' | 'organizationId' | 'userId' | 'role'
  operator: Operator
  values: string[]
}

/** Validates sortBy and the filter of a list request; returns the filter, if any. */
export function checkListQuery(path: string | undefined, query: unknown): Filter | undefined {
  const list = path === undefined ? undefined : LISTS[path]
  if (!list || !isRecord(query)) return undefined
  const { sortBy, filterField, filterValue, filterOperator } = query
  if (sortBy !== undefined && (typeof sortBy !== 'string' || !list.sortable.includes(sortBy))) {
    throw bad('INVALID_FIELD', `sortBy must be one of ${list.sortable.join(', ')}`)
  }
  if (filterField === undefined) return undefined
  if (typeof filterField !== 'string' || !list.filterable.includes(filterField)) {
    throw bad(
      'INVALID_FIELD',
      list.filterable.length
        ? `filterField must be one of ${list.filterable.join(', ')}`
        : 'this list cannot be filtered',
    )
  }
  const operator = filterOperator ?? 'eq'
  if (typeof operator !== 'string' || !(OPERATORS as readonly string[]).includes(operator)) {
    throw bad('INVALID_FILTER', `filterOperator must be one of ${OPERATORS.join(', ')}`)
  }
  const many = operator === 'in' || operator === 'not_in'
  if (many !== Array.isArray(filterValue)) {
    throw bad(
      'INVALID_FILTER',
      many
        ? `filterOperator ${operator} needs several filterValue parameters`
        : 'filterValue must be a single value (use filterOperator=in for several)',
    )
  }
  const values: unknown[] = Array.isArray(filterValue) ? filterValue : [filterValue]
  if (!values.every((v): v is string => typeof v === 'string')) {
    throw bad('INVALID_FILTER', 'filterValue is required')
  }
  if (list.uuids.includes(filterField) && !values.every(isUuid)) {
    throw bad('INVALID_ID', `filterValue must be a UUID for ${filterField}`)
  }
  return { field: filterField as Filter['field'], operator: operator as Operator, values }
}

/**
 * Better Auth 1.7.10's list-members fails with a 500 whenever the page is empty (it looks
 * the members' users up with `id IN ()`): a filter that matches nobody, or an offset past
 * the end. For a caller allowed to see the list, answer those cases here with the empty
 * list Better Auth would have returned. Everything else, including refusals, is left to it.
 */
export async function emptyMemberList(ctx: AuthMiddlewareContext, db: Db, filter?: Filter) {
  if (ctx.path !== '/organization/list-members') return undefined
  const query = isRecord(ctx.query) ? ctx.query : {}
  const session = await getSessionFromCtx(ctx)
  if (!session) return undefined
  let organizationId: unknown = query.organizationId ?? session.session.activeOrganizationId
  if (typeof query.organizationSlug === 'string') {
    const org = await db
      .selectFrom('auth.organization')
      .select('id')
      .where('slug', '=', query.organizationSlug)
      .executeTakeFirst()
    organizationId = org?.id
  }
  if (typeof organizationId !== 'string' || !isUuid(organizationId)) return undefined
  if (!(await isMember(db, session.user.id, organizationId))) return undefined
  // Requests Better Auth would refuse are left to it.
  const { sortDirection, limit, offset: rawOffset } = query
  if (sortDirection !== undefined && sortDirection !== 'asc' && sortDirection !== 'desc') {
    return undefined
  }
  if (![limit, rawOffset].every((v) => v === undefined || Number.isFinite(Number(v)))) {
    return undefined
  }

  let count = db
    .selectFrom('auth.member')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('organizationId', '=', organizationId)
  if (filter) {
    const { field, operator, values } = filter
    const [first = ''] = values
    if (operator === 'eq') count = count.where(field, '=', first)
    else if (operator === 'ne') count = count.where(field, '<>', first)
    else if (operator === 'in') count = count.where(field, 'in', values)
    else count = count.where(field, 'not in', values)
  }
  const total = Number((await count.executeTakeFirstOrThrow()).n)
  const offset = Number(rawOffset ?? 0)
  if (total > 0 && !(Number.isFinite(offset) && offset >= total)) return undefined
  return ctx.json({ members: [], total })
}
