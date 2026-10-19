import type pg from 'pg'

interface NamedObject {
  schema: string
  name: string
}

interface Relation extends NamedObject {
  kind: string
  persistence: string
  access_method: string | null
  row_security: boolean
  force_row_security: boolean
  replica_identity: string
  partition_key: string | null
  partition_bound: string | null
  parents: string[]
  options: string[]
}

interface Column {
  schema: string
  relation: string
  name: string
  position: number
  type: string
  collation: string | null
  not_null: boolean
  default: string | null
  identity: string
  generated: string
  storage: string
  compression: string
}

interface Constraint extends NamedObject {
  relation: string | null
  domain: string | null
  kind: string
  definition: string
  validated: boolean
  deferrable: boolean
  initially_deferred: boolean
  no_inherit: boolean
}

interface Index extends NamedObject {
  relation: string
  definition: string
  valid: boolean
  ready: boolean
  live: boolean
  clustered: boolean
  replica_identity: boolean
  options: string[]
}

interface Trigger extends NamedObject {
  relation: string
  enabled: string
  definition: string
}

interface Function extends NamedObject {
  arguments: string
  kind: string
  definition: string
}

interface Type extends NamedObject {
  kind: string
  base_type: string | null
  not_null: boolean
  default: string | null
  collation: string | null
  enum_labels: string[]
  range_subtype: string | null
  range_collation: string | null
  range_operator_class: string | null
  range_canonical: string | null
  range_subtype_diff: string | null
  range_multirange: string | null
}

interface Sequence extends NamedObject {
  type: string
  start: string
  increment: string
  minimum: string
  maximum: string
  cache: string
  cycle: boolean
  owned_by: string | null
  dependency: string | null
}

interface Policy extends NamedObject {
  relation: string
  permissive: boolean
  command: string
  roles: string[]
  using: string | null
  check: string | null
}

interface View extends NamedObject {
  definition: string
}

interface Extension extends NamedObject {
  version: string
  relocatable: boolean
}

export interface SchemaSnapshot {
  schemas: { name: string }[]
  relations: Relation[]
  columns: Column[]
  constraints: Constraint[]
  indexes: Index[]
  triggers: Trigger[]
  functions: Function[]
  types: Type[]
  sequences: Sequence[]
  policies: Policy[]
  views: View[]
  extensions: Extension[]
}

/**
 * Compares application DDL, including Better Auth's schema, independently of database
 * OIDs, row contents, ownership and sequence counters. pg-boss maintains its own schema
 * outside our migration runner. One connection and a fixed search_path keep deparsed SQL
 * deterministic without changing the caller's pool settings.
 */
export async function snapshotSchema(pool: pg.Pool): Promise<SchemaSnapshot> {
  const client = await pool.connect()
  const schemas = ['auth', 'public']
  const rows = async <T extends pg.QueryResultRow>(sql: string): Promise<T[]> =>
    (await client.query<T>(sql, [schemas])).rows

  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query('SET LOCAL search_path TO pg_catalog')
    const snapshot: SchemaSnapshot = {
      schemas: await rows(`
        SELECT nspname AS name FROM pg_namespace
        WHERE nspname = ANY($1) ORDER BY nspname`),
      relations: await rows(`
        SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
               c.relpersistence AS persistence, am.amname AS access_method,
               c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security,
               c.relreplident AS replica_identity,
               pg_get_partkeydef(c.oid) AS partition_key,
               pg_get_expr(c.relpartbound, c.oid) AS partition_bound,
               ARRAY(SELECT format('%I.%I', pn.nspname, p.relname)
                     FROM pg_inherits i
                     JOIN pg_class p ON p.oid = i.inhparent
                     JOIN pg_namespace pn ON pn.oid = p.relnamespace
                     WHERE i.inhrelid = c.oid ORDER BY i.inhseqno) AS parents,
               ARRAY(SELECT unnest(c.reloptions) ORDER BY 1) AS options
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_am am ON am.oid = c.relam
        WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
        ORDER BY n.nspname, c.relname`),
      columns: await rows(`
        SELECT n.nspname AS schema, c.relname AS relation, a.attname AS name,
               a.attnum::integer AS position, format_type(a.atttypid, a.atttypmod) AS type,
               CASE WHEN a.attcollation = 0 THEN NULL
                    ELSE a.attcollation::regcollation::text END AS collation,
               a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default,
               a.attidentity AS identity, a.attgenerated AS generated,
               a.attstorage AS storage, a.attcompression AS compression
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
          AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
        ORDER BY n.nspname, c.relname, a.attnum`),
      constraints: await rows(`
        SELECT n.nspname AS schema, c.conname AS name, r.relname AS relation,
               t.typname AS domain, c.contype AS kind,
               pg_get_constraintdef(c.oid, true) AS definition, c.convalidated AS validated,
               c.condeferrable AS deferrable, c.condeferred AS initially_deferred,
               c.connoinherit AS no_inherit
        FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        LEFT JOIN pg_class r ON r.oid = c.conrelid
        LEFT JOIN pg_type t ON t.oid = c.contypid
        WHERE n.nspname = ANY($1)
        ORDER BY n.nspname, r.relname, t.typname, c.conname`),
      indexes: await rows(`
        SELECT n.nspname AS schema, c.relname AS name, t.relname AS relation,
               pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid AS valid,
               i.indisready AS ready, i.indislive AS live, i.indisclustered AS clustered,
               i.indisreplident AS replica_identity,
               ARRAY(SELECT unnest(c.reloptions) ORDER BY 1) AS options
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1) ORDER BY n.nspname, c.relname`),
      triggers: await rows(`
        SELECT n.nspname AS schema, t.tgname AS name, c.relname AS relation,
               t.tgenabled AS enabled, pg_get_triggerdef(t.oid, true) AS definition
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1) AND NOT t.tgisinternal
        ORDER BY n.nspname, c.relname, t.tgname`),
      functions: await rows(`
        SELECT n.nspname AS schema, p.proname AS name,
               pg_get_function_identity_arguments(p.oid) AS arguments,
               p.prokind AS kind, pg_get_functiondef(p.oid) AS definition
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ANY($1) AND p.prokind <> 'a'
        ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)`),
      types: await rows(`
        SELECT n.nspname AS schema, t.typname AS name, t.typtype AS kind,
               CASE WHEN t.typbasetype = 0 THEN NULL
                    ELSE format_type(t.typbasetype, t.typtypmod) END AS base_type,
               t.typnotnull AS not_null, pg_get_expr(t.typdefaultbin, 0) AS default,
               CASE WHEN t.typcollation = 0 THEN NULL
                    ELSE t.typcollation::regcollation::text END AS collation,
               ARRAY(SELECT e.enumlabel::text FROM pg_enum e
                     WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder) AS enum_labels,
               r.rngsubtype::regtype::text AS range_subtype,
               CASE WHEN r.rngcollation = 0 THEN NULL
                    ELSE r.rngcollation::regcollation::text END AS range_collation,
               CASE WHEN oc.oid IS NULL THEN NULL
                    ELSE format('%I.%I', ocn.nspname, oc.opcname) END AS range_operator_class,
               CASE WHEN r.rngcanonical = 0 THEN NULL
                    ELSE r.rngcanonical::regprocedure::text END AS range_canonical,
               CASE WHEN r.rngsubdiff = 0 THEN NULL
                    ELSE r.rngsubdiff::regprocedure::text END AS range_subtype_diff,
               r.rngmultitypid::regtype::text AS range_multirange
        FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        LEFT JOIN pg_class c ON c.oid = t.typrelid
        LEFT JOIN pg_range r ON r.rngtypid = t.oid OR r.rngmultitypid = t.oid
        LEFT JOIN pg_opclass oc ON oc.oid = r.rngsubopc
        LEFT JOIN pg_namespace ocn ON ocn.oid = oc.opcnamespace
        WHERE n.nspname = ANY($1)
          AND (t.typtype IN ('e', 'd', 'r', 'm') OR (t.typtype = 'c' AND c.relkind = 'c'))
        ORDER BY n.nspname, t.typname`),
      sequences: await rows(`
        SELECT n.nspname AS schema, c.relname AS name, s.seqtypid::regtype::text AS type,
               s.seqstart::text AS start, s.seqincrement::text AS increment,
               s.seqmin::text AS minimum, s.seqmax::text AS maximum,
               s.seqcache::text AS cache, s.seqcycle AS cycle,
               CASE WHEN a.attname IS NULL THEN NULL
                    ELSE format('%I.%I.%I', rn.nspname, r.relname, a.attname) END AS owned_by,
               d.deptype AS dependency
        FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = c.oid
          AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
        LEFT JOIN pg_class r ON r.oid = d.refobjid
        LEFT JOIN pg_namespace rn ON rn.oid = r.relnamespace
        LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
        WHERE n.nspname = ANY($1) ORDER BY n.nspname, c.relname`),
      policies: await rows(`
        SELECT n.nspname AS schema, p.polname AS name, c.relname AS relation,
               p.polpermissive AS permissive, p.polcmd AS command,
               ARRAY(SELECT CASE WHEN role_id = 0 THEN 'PUBLIC' ELSE r.rolname::text END
                     FROM unnest(p.polroles) AS role_id
                     LEFT JOIN pg_roles r ON r.oid = role_id ORDER BY 1) AS roles,
               pg_get_expr(p.polqual, p.polrelid) AS using,
               pg_get_expr(p.polwithcheck, p.polrelid) AS check
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1) ORDER BY n.nspname, c.relname, p.polname`),
      views: await rows(`
        SELECT n.nspname AS schema, c.relname AS name, pg_get_viewdef(c.oid, true) AS definition
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1) AND c.relkind IN ('v', 'm')
        ORDER BY n.nspname, c.relname`),
      extensions: await rows(`
        SELECT n.nspname AS schema, e.extname AS name, e.extversion AS version,
               e.extrelocatable AS relocatable
        FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE n.nspname = ANY($1) ORDER BY n.nspname, e.extname`),
    }
    await client.query('COMMIT')
    return snapshot
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
