import { createPool, runMigrations } from './index.ts'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

const pool = createPool(url)
try {
  const applied = await runMigrations(pool)
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date')
} finally {
  await pool.end()
}
