import { setTimeout } from 'node:timers/promises'
import { Kysely, PostgresDialect } from 'kysely'
import type pg from 'pg'
import { expect } from 'vitest'
import { lockOrganization } from '../../scheduling/src/hosts.ts'
import type { Database } from './index.ts'
import {
  formValues,
  insertRow,
  type RoutingFixture,
  versionValues,
} from './routing-storage-fixtures.ts'
import { readRoutingStorageLimits } from './routing-storage-limits.ts'

export async function checkQuotaRace(
  f: RoutingFixture,
  kind: 'forms' | 'totalForms' | 'versions',
  repeatableRead = false,
) {
  const limits = readRoutingStorageLimits()
  const forms = kind !== 'versions'
  const limit =
    kind === 'forms'
      ? limits.forms_per_organization
      : kind === 'totalForms'
        ? limits.total_forms_per_organization
        : limits.versions_per_form
  if (forms)
    await f.pool.query(
      `INSERT INTO routing_forms (organization_id,slug,created_by_user_id,draft,archived_at)
      SELECT $1,'race-' || n,$2,'{}',$4::timestamptz FROM generate_series(2,$3::int) n`,
      [f.organization, f.creator, limit - 1, kind === 'totalForms' ? '2026-01-01T00:00:00Z' : null],
    )
  else
    await f.pool.query(
      `INSERT INTO routing_form_versions
      (organization_id,form_id,version_number,questions,rules,fallback,published_by_user_id)
      SELECT $1,$2,n,'[]','[]','{}',$3 FROM generate_series(2,$4::int) n`,
      [f.organization, f.form, f.creator, limit - 1],
    )
  const first = await f.pool.connect()
  const second = await f.pool.connect()
  let contender: Promise<{ ok: boolean; code?: string; constraint?: string }> | undefined
  try {
    const firstPid = (await first.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
      ?.pid
    const secondPid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0]?.pid
    await first.query('BEGIN')
    await second.query(repeatableRead ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN')
    if (repeatableRead) await second.query('SELECT count(*) FROM routing_forms')
    if (forms) {
      await shareOrganization(first, f.organization)
      await shareOrganization(second, f.organization)
    }
    await insertRow(
      first,
      forms ? 'routing_forms' : 'routing_form_versions',
      forms
        ? { ...formValues(f), archived_at: kind === 'totalForms' ? '2026-01-01T00:00:00Z' : null }
        : { ...versionValues(f), version_number: limit },
    )
    let settled = false
    contender = insertRow(
      second,
      forms ? 'routing_forms' : 'routing_form_versions',
      forms
        ? { ...formValues(f), archived_at: kind === 'totalForms' ? '2026-01-01T00:00:00Z' : null }
        : { ...versionValues(f), version_number: limit + 1 },
    )
      .then(
        () => ({ ok: true }),
        (error: { code: string; constraint: string }) => ({
          ok: false,
          code: error.code,
          constraint: error.constraint,
        }),
      )
      .finally(() => {
        settled = true
      })
    // Observe real blocking before committing. The unlocked mutant instead completes
    // while the first insert is uncommitted, so both writers see the last free slot.
    let waiting = false
    for (let attempt = 0; attempt < 200 && !settled; attempt++) {
      waiting =
        (
          await first.query<{ waiting: boolean }>(
            'SELECT $1::integer=ANY(pg_blocking_pids($2)) AS waiting',
            [firstPid, secondPid],
          )
        ).rows[0]?.waiting ?? false
      if (waiting) break
      await setTimeout(5)
    }
    expect(waiting || settled).toBe(true)
    await first.query('COMMIT')
    const outcome = await contender
    if (repeatableRead) expect(outcome).toMatchObject({ ok: false, code: '40001' })
    else
      expect(outcome).toEqual({
        ok: false,
        code: '23514',
        constraint:
          kind === 'forms'
            ? 'routing_forms_quota'
            : kind === 'totalForms'
              ? 'routing_forms_total_quota'
              : 'routing_form_versions_quota',
      })
    await second.query('ROLLBACK')
    expect(
      (
        await first.query(
          `SELECT count(*)::int AS count FROM ${forms ? 'routing_forms WHERE organization_id' : 'routing_form_versions WHERE form_id'}=$1`,
          [forms ? f.organization : f.form],
        )
      ).rows,
    ).toEqual([{ count: limit }])
    expect(f.pool.totalCount).toBeLessThanOrEqual(2)
  } finally {
    await first.query('ROLLBACK')
    await contender
    await second.query('ROLLBACK')
    first.release()
    second.release()
  }
}

// Use the production lockOrganization implementation on the checked-out transaction.
// The adapter borrows that client and neither creates a pool nor releases its owner.
async function shareOrganization(client: pg.PoolClient, organization: string) {
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: {
        options: {},
        connect: async () =>
          new Proxy(client, {
            get(target, property) {
              if (property === 'release') return () => {}
              const value = Reflect.get(target, property)
              return typeof value === 'function' ? value.bind(target) : value
            },
          }),
        end: async () => {},
      },
    }),
  })
  try {
    await lockOrganization(db, organization)
  } finally {
    await db.destroy()
  }
}

export async function checkSharedOrganizationLocks(f: RoutingFixture, booking = false) {
  const first = await f.pool.connect()
  const second = await f.pool.connect()
  try {
    await first.query('BEGIN')
    await second.query('BEGIN')
    await first.query("SET LOCAL lock_timeout='2s'")
    await second.query("SET LOCAL lock_timeout='2s'")
    await shareOrganization(first, f.organization)
    await shareOrganization(second, f.organization)
    if (booking) {
      // A booking transaction has already taken the ordinary organization share lock.
      await first.query('SELECT id FROM bookings WHERE id=$1 FOR UPDATE', [f.booking])
      const inserted = await insertRow(second, 'routing_forms', formValues(f)).then(
        () => ({ ok: true }),
        (error: { code: string }) => ({ ok: false, code: error.code }),
      )
      expect(inserted).toEqual({ ok: true })
      await second.query('COMMIT')
      await first.query('COMMIT')
    } else {
      const create = async (client: pg.PoolClient) => {
        try {
          await insertRow(client, 'routing_forms', formValues(f))
          await client.query('COMMIT')
          return { ok: true }
        } catch (error) {
          await client.query('ROLLBACK')
          return { ok: false, code: (error as { code: string }).code }
        }
      }
      expect(await Promise.all([create(first), create(second)])).toEqual([
        { ok: true },
        { ok: true },
      ])
    }
    expect(
      (
        await first.query(
          'SELECT count(*)::int AS count FROM routing_forms WHERE organization_id=$1',
          [f.organization],
        )
      ).rows,
    ).toEqual([{ count: booking ? 2 : 3 }])
  } finally {
    await first.query('ROLLBACK')
    await second.query('ROLLBACK')
    first.release()
    second.release()
  }
}
