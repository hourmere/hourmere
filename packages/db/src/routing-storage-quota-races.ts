import { setTimeout } from 'node:timers/promises'
import { expect } from 'vitest'
import {
  formValues,
  insertRow,
  type RoutingFixture,
  versionValues,
} from './routing-storage-fixtures.ts'

export async function checkQuotaRace(
  f: RoutingFixture,
  kind: 'forms' | 'versions',
  repeatableRead = false,
) {
  if (kind === 'forms')
    await f.pool.query(
      `INSERT INTO routing_forms (organization_id,slug,created_by_user_id,draft)
      SELECT $1,'race-' || n,$2,'{}' FROM generate_series(2,99) n`,
      [f.organization, f.creator],
    )
  else
    await f.pool.query(
      `INSERT INTO routing_form_versions
      (organization_id,form_id,version_number,questions,rules,fallback,published_by_user_id)
      SELECT $1,$2,n,'[]','[]','{}',$3 FROM generate_series(2,999) n`,
      [f.organization, f.form, f.creator],
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
    await insertRow(
      first,
      kind === 'forms' ? 'routing_forms' : 'routing_form_versions',
      kind === 'forms' ? formValues(f) : { ...versionValues(f), version_number: 1000 },
    )
    let settled = false
    contender = insertRow(
      second,
      kind === 'forms' ? 'routing_forms' : 'routing_form_versions',
      kind === 'forms' ? formValues(f) : { ...versionValues(f), version_number: 1001 },
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
        constraint: kind === 'forms' ? 'routing_forms_quota' : 'routing_form_versions_quota',
      })
    await second.query('ROLLBACK')
    expect(
      (
        await first.query(
          `SELECT count(*)::int AS count FROM ${kind === 'forms' ? 'routing_forms WHERE organization_id' : 'routing_form_versions WHERE form_id'}=$1`,
          [kind === 'forms' ? f.organization : f.form],
        )
      ).rows,
    ).toEqual([{ count: kind === 'forms' ? 100 : 1000 }])
    expect(f.pool.totalCount).toBeLessThanOrEqual(2)
  } finally {
    await first.query('ROLLBACK')
    await contender
    await second.query('ROLLBACK')
    first.release()
    second.release()
  }
}
