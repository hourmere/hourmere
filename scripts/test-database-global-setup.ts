// Migrate the common historical prefix once, then build the latest schema from it.
// Both types of fixture verify checksums for copied migrations before applying the rest.
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrations } from '@hourmere/db'
import { MIGRATED_PREFIX_LAST_FILE, templateServer } from '@hourmere/db/test-database-registry'
import { createTestDatabaseTemplate, type TestDatabaseTemplate } from '@hourmere/db/testing'
import type { TestProject } from 'vitest/node'
import { migrationsDir } from '../packages/db/src/migrate.ts'

let template: TestDatabaseTemplate | undefined
let prefix: TestDatabaseTemplate | undefined

async function dropTemplates(): Promise<void> {
  const current = template
  const currentPrefix = prefix
  template = undefined
  prefix = undefined
  // A leftover template is removed by `npm run db:cleanup-tests`; it must not fail a green run.
  for (const owned of [current, currentPrefix]) {
    await owned?.drop().catch(() => {
      console.warn('Could not drop a migrated test template')
    })
  }
}

/** The failure's code and message, with the server URL and any password removed. */
export function templateFailure(error: unknown, serverUrl: string): string {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown }
  let text = `${typeof code === 'string' ? `${code}: ` : ''}${typeof message === 'string' ? message : String(error)}`
  const secrets = [serverUrl]
  try {
    // A URL derived from the server URL (another database name) carries the password as written.
    const raw = new URL(serverUrl).password
    if (raw) secrets.push(raw)
    const password = decodeURIComponent(raw)
    if (password && password !== raw) secrets.push(password)
  } catch {}
  for (const secret of secrets) text = text.replaceAll(secret, '[redacted]')
  return text
}

async function prepare(project: TestProject, serverUrl: string): Promise<void> {
  await dropTemplates()
  try {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-run-prefix-'))
    try {
      const files = (await readdir(migrationsDir)).filter(
        (file) => file.endsWith('.sql') && file <= MIGRATED_PREFIX_LAST_FILE,
      )
      if (!files.includes(MIGRATED_PREFIX_LAST_FILE)) {
        throw new Error(`Missing test migration checkpoint ${MIGRATED_PREFIX_LAST_FILE}`)
      }
      await Promise.all(
        files.map((file) => copyFile(join(migrationsDir, file), join(directory, file))),
      )
      prefix = await createTestDatabaseTemplate(
        serverUrl,
        async (pool) => {
          await runMigrations(pool, directory)
        },
        { tag: 'prefix' },
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }

    template = await createTestDatabaseTemplate(
      serverUrl,
      async (pool) => {
        await runMigrations(pool)
      },
      { tag: 'migrated', template: prefix.name },
    )
  } catch (error) {
    // Database tests then migrate their own fixtures and report the real failure; tests that
    // need no database still run. Say why, without the connection string a driver error can
    // quote.
    console.warn(
      `No migrated test template (${templateFailure(error, serverUrl)}); falling back: each database fixture replays every migration`,
    )
    await dropTemplates()
    project.provide('migratedTestTemplate', undefined)
    return
  }
  project.provide('migratedTestTemplate', {
    name: template.name,
    prefix: prefix.name,
    server: templateServer(serverUrl),
  })
}

export async function setup(project: TestProject): Promise<void> {
  const serverUrl = process.env.DATABASE_URL
  if (!serverUrl) return
  await prepare(project, serverUrl)
  // Watch mode: a migration edited since the last run must not meet a template that recorded
  // its old checksum, so every rerun starts from a freshly migrated template.
  project.onTestsRerun(() => prepare(project, serverUrl))
}

export async function teardown(): Promise<void> {
  await dropTemplates()
}
