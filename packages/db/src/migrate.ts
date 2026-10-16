import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'

export const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url))

// Files are recorded by name, so the naming rule can never change: four digits, then a
// lowercase description. Zero-padding keeps 0010 after 0009.
const NAME = /^\d{4}_[a-z0-9_]+\.sql$/

// Arbitrary constant shared by every instance, so concurrent starts apply migrations once.
const LOCK_ID = 7_340_172

/**
 * Applies `NNNN_name.sql` files in order, each in its own transaction, and records them
 * with a SHA-256 checksum in `schema_migrations`. Applied files are skipped; an applied
 * file whose contents changed is an error, because the database no longer matches it.
 */
export async function runMigrations(pool: pg.Pool, dir = migrationsDir): Promise<string[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  const badName = entries.find((f) => !NAME.test(f))
  if (badName) throw new Error(`migration file name ${badName} does not match NNNN_name.sql`)

  const client = await pool.connect()
  const applied: string[] = []
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID])
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    )
    const done = new Map(
      (
        await client.query<{ name: string; checksum: string }>(
          'SELECT name, checksum FROM schema_migrations',
        )
      ).rows.map((r) => [r.name, r.checksum]),
    )
    for (const file of entries) {
      const sql = await readFile(join(dir, file), 'utf8')
      // Line endings are normalized so a CRLF checkout (Git for Windows) and the official
      // image agree on the checksum of the same migration.
      const checksum = createHash('sha256').update(sql.replaceAll('\r\n', '\n')).digest('hex')
      const recorded = done.get(file)
      if (recorded !== undefined) {
        if (recorded !== checksum) {
          throw new Error(
            `migration ${file} was changed after it was applied; add a new file instead`,
          )
        }
        continue
      }
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ])
        await client.query('COMMIT')
      } catch (err) {
        // A failed ROLLBACK (e.g. connection lost) must not hide the original error.
        await client.query('ROLLBACK').catch(() => {})
        throw new Error(`migration ${file} failed`, { cause: err })
      }
      applied.push(file)
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {})
    // Destroy rather than return the connection: a migration may have changed session
    // settings (search_path, timeouts) that must not leak into application queries.
    client.release(true)
  }
  return applied
}
