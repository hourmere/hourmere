// Migrates one template database per test run. Fixtures that use the repository's migrations
// copy it with CREATE DATABASE … TEMPLATE instead of replaying every migration per database.
// The copy still runs the migrations, which skips the files the template recorded after
// verifying their checksums, so a stale template fails instead of hiding a change.
import { runMigrations } from '@hourmere/db'
import { templateServer } from '@hourmere/db/test-database-registry'
import { createTestDatabaseTemplate, type TestDatabaseTemplate } from '@hourmere/db/testing'
import type { TestProject } from 'vitest/node'

let template: TestDatabaseTemplate | undefined

export async function setup(project: TestProject): Promise<void> {
  const serverUrl = process.env.DATABASE_URL
  if (!serverUrl) return
  try {
    template = await createTestDatabaseTemplate(
      serverUrl,
      async (pool) => {
        await runMigrations(pool)
      },
      { tag: 'migrated' },
    )
  } catch {
    // Database tests then migrate their own fixtures and report the real failure; tests that
    // need no database still run. Do not print the error: it can contain connection details.
    console.warn('No migrated test template; database fixtures replay every migration')
    return
  }
  project.provide('migratedTestTemplate', {
    name: template.name,
    server: templateServer(serverUrl),
  })
}

export async function teardown(): Promise<void> {
  await template?.drop()
  template = undefined
}
