import { spawnSync } from 'node:child_process'

// Optional diagnostic lane; DATABASE_URL still enables isolated PostgreSQL tests.
const offsets = process.env.HOURMERE_TEST_CLOCK_OFFSET_DAYS
  ? [process.env.HOURMERE_TEST_CLOCK_OFFSET_DAYS]
  : ['7', '30', '90', '400', '1600']
for (const days of offsets) {
  console.log(`\nRunning tests with the Node wall clock offset by +${days} days`)
  const result = spawnSync(
    'npm',
    ['test', '--', '--maxWorkers=2', '--no-fsModuleCache', ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: { ...process.env, HOURMERE_TEST_CLOCK_OFFSET_DAYS: days },
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
