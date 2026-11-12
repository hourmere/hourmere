// Recognises a PostgreSQL error about the SSO storage tables (migrations 0074 and 0075) so the
// error log can omit its diagnostic. A refused row's detail repeats the whole row ("Failing
// row contains (...)"), with a link's proven mailbox, an attempt's mailbox, a provider's
// issuer and sealed configuration or a domain's challenge digest, and a unique violation
// repeats the key, such as an IdP subject. This module only recognises table and
// constraint names in errors the driver raised; it performs no data access.

/** The SSO configuration storage (0074) and identity storage (0075) tables. */
export const SSO_STORAGE_TABLES: ReadonlySet<string> = new Set([
  'sso_policies',
  'sso_providers',
  'sso_domains',
  'sso_provider_domains',
  'sso_recovery_nominations',
  'sso_recovery_owners',
  'sso_identity_links',
  'sso_attempts',
  'sso_mailbox_tokens',
  'sso_replay_cache',
  'sso_browser_proofs',
  'sso_delegation_bindings',
])

/**
 * Rules the storage triggers raise whose names do not start with a table's name. Such an
 * error names no table (a trigger's RAISE sets only the constraint), so it is recognised by
 * the rule alone. Every other constraint, index, trigger and raised rule of these tables
 * starts with its table's name (sso-storage-errors.test.ts checks both migrations and the
 * catalogue).
 */
export const SSO_STORAGE_SHARED_RULES: ReadonlySet<string> = new Set([
  'sso_team_organization',
  'sso_recovery_immutable',
  'sso_recovery_current_owner',
  'sso_reliance_immutable',
  'sso_reliance_live',
  'sso_reliance_member',
  'sso_reliance_provider',
  'sso_reliance_link',
  'sso_reliance_trust_generation',
  'sso_reliance_domain',
])

export const SSO_STORAGE_DIAGNOSTIC_OMITTED = '[private SSO storage diagnostic omitted]'

const IDENTIFIER = /^[A-Za-z0-9_]{1,63}$/
const MAX_DEPTH = 8
const MAX_VISITED = 64

const isSsoStorageConstraint = (name: string) =>
  SSO_STORAGE_SHARED_RULES.has(name) ||
  [...SSO_STORAGE_TABLES].some((table) => name === table || name.startsWith(`${table}_`))

/**
 * For a PostgreSQL driver error (a five-character SQLSTATE `code`) about an SSO storage
 * table, its identifier-shaped code, table and constraint; null for anything else.
 */
function storageError(value: object): string[] | null {
  const { code, table, constraint } = value as Record<string, unknown>
  if (typeof code !== 'string' || code.length !== 5) return null
  const matches =
    (typeof table === 'string' && SSO_STORAGE_TABLES.has(table)) ||
    (typeof constraint === 'string' && isSsoStorageConstraint(constraint))
  if (!matches) return null
  return Object.entries({ code, table, constraint })
    .filter(([, name]) => typeof name === 'string' && IDENTIFIER.test(name))
    .map(([field, name]) => `${field}=${name}`)
}

/**
 * The text to log instead of an error when it, its `cause` chain or an AggregateError's
 * `errors` (to a bounded depth, cycles included) holds a database error about the SSO storage
 * tables: a fixed marker and only the SQLSTATE, table and constraint names, never the
 * message, detail, hint, where, values or parameters. Undefined for any other error. Never
 * throws; an object whose fields cannot be read is skipped.
 */
export function ssoStorageDiagnostic(error: unknown): string | undefined {
  const seen = new Set<object>()
  const queue: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }]
  while (queue.length > 0 && seen.size < MAX_VISITED) {
    const next = queue.shift()
    if (!next) break
    const { value, depth } = next
    if (typeof value !== 'object' || value === null || seen.has(value)) continue
    seen.add(value)
    try {
      const fields = storageError(value)
      if (fields) return [SSO_STORAGE_DIAGNOSTIC_OMITTED, ...fields].join(' ')
      if (depth >= MAX_DEPTH) continue
      const { cause, errors } = value as { cause?: unknown; errors?: unknown }
      if (cause !== undefined) queue.push({ value: cause, depth: depth + 1 })
      if (Array.isArray(errors))
        for (const item of errors.slice(0, MAX_VISITED))
          queue.push({ value: item, depth: depth + 1 })
    } catch {
      // A throwing getter or proxy: nothing more is read from this object.
    }
  }
  return undefined
}
