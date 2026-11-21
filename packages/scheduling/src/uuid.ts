const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Ids from requests are checked before they reach a Postgres UUID column. */
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value)
