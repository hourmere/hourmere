// Second half of `npm run db:migrate`, for instances started with AUTO_MIGRATE=false: installs
// or upgrades pg-boss's own `pgboss` schema with pg-boss's CLI. Our runner never touches that
// schema. The CLI builds pg-boss's indexes inline; a running instance with migrate on builds
// them in the background instead.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

const cli = fileURLToPath(import.meta.resolve('pg-boss/dist/cli.js'))
const result = spawnSync(process.execPath, [cli, 'migrate'], {
  stdio: 'inherit',
  env: { ...process.env, PGBOSS_DATABASE_URL: url },
})
process.exit(result.status ?? 1)
