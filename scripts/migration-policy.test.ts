import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const migrations =
  process.env.HOURMERE_MIGRATIONS_DIR ??
  fileURLToPath(new URL('../packages/db/migrations/', import.meta.url))

it('requires an upgrade note beside every migration that drops a column', () => {
  const undocumented = readdirSync(migrations)
    .filter((name) => name.endsWith('.sql'))
    .filter((name) => {
      const sql = readFileSync(join(migrations, name), 'utf8')
      // This lint is deliberately conservative; ignore SQL comments, including comments
      // between DROP and COLUMN, without running any migration against a database.
      const statements = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
      if (!/\bDROP\s+COLUMN\b/i.test(statements)) return false
      const note = join(migrations, name.replace(/\.sql$/, '.md'))
      return (
        !existsSync(note) || !/^Column-drop upgrade:[ \t]*\S.*$/m.test(readFileSync(note, 'utf8'))
      )
    })
  expect(undocumented, 'Add a matching .md sidecar with a Column-drop upgrade: note').toEqual([])
})
