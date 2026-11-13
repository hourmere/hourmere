// Migrates one template database per test run. Fixtures that use the repository's migrations
// copy it with CREATE DATABASE … TEMPLATE instead of replaying every migration per database.
// The copy still runs the migrations, which skips the files the template recorded after
// verifying their checksums, so a stale template fails instead of hiding a change.
import { runMigrations } from '@hourmere/db'
import { templateServer } from '@hourmere/db/test-database-registry'
import { createTestDatabaseTemplate, type TestDatabaseTemplate } from '@hourmere/db/testing'
import type { TestProject } from 'vitest/node'

let template: TestDatabaseTemplate | undefined

async function dropTemplate(): Promise<void> {
  const current = template
  template = undefined
  // A leftover template is removed by `npm run db:cleanup-tests`; it must not fail a green run.
  await current?.drop().catch(() => {
    console.warn('Could not drop the migrated test template')
  })
}

/** The failure's code and message, with the server URL and any password removed. */
export function templateFailure(error: unknown, serverUrl: string): string {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown }
  let text = `${typeof code === 'string' ? `${code}: ` : ''}${typeof message === 'string' ? message : String(error)}`
  const secrets = [serverUrl]
  try {
    const password = decodeURIComponent(new URL(serverUrl).password)
    if (password) secrets.push(password)
  } catch {}
  for (const secret of secrets) text = text.replaceAll(secret, '[redacted]')
  return text
}

async function prepare(project: TestProject, serverUrl: string): Promise<void> {
  await dropTemplate()
  try {
    template = await createTestDatabaseTemplate(
      serverUrl,
      async (pool) => {
        await runMigrations(pool)
      },
      { tag: 'migrated' },
    )
  } catch (error) {
    // Database tests then migrate their own fixtures and report the real failure; tests that
    // need no database still run. Say why, without the connection string a driver error can
    // quote.
    console.warn(
      `No migrated test template (${templateFailure(error, serverUrl)}); falling back: each database fixture replays every migration`,
    )
    project.provide('migratedTestTemplate', undefined)
    return
  }
  project.provide('migratedTestTemplate', {
    name: template.name,
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
  await dropTemplate()
}
