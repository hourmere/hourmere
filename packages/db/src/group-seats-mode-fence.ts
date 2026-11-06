import pg from 'pg'
import { expect } from 'vitest'
import { type GroupFixture, groupFixture, insertRecord } from './group-seats-fixtures.ts'
import { guardPoolErrors } from './index.ts'

/** Ordinary inserts must retain their FK lock compatibility and fence mode changes. */
export async function assertGroupModeFence(initial: GroupFixture, rounds = 1) {
  const pool = new pg.Pool({
    connectionString: initial.pool.options.connectionString,
    max: 2,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  })
  guardPoolErrors(pool, 'group mode fence')
  try {
    for (let round = 0; round < rounds; round++) {
      const f = round === 0 ? initial : await groupFixture(initial.pool)
      await f.pool.query(
        `UPDATE event_types SET booking_mode='individual',group_capacity=NULL WHERE id=$1`,
        [f.event],
      )
      const writer = await pool.connect()
      let conversion: pg.PoolClient | undefined
      let result: Promise<{ code: string | undefined }> | undefined
      try {
        conversion = await pool.connect()
        const pids = await Promise.all(
          [writer, conversion].map(
            async (client) =>
              (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
                ?.pid as number,
          ),
        )
        expect(new Set(pids).size).toBe(2)
        await writer.query('BEGIN')
        await conversion.query('BEGIN')
        await insertRecord(writer, 'bookings', {
          organization_id: f.organization,
          event_type_id: f.event,
          start_at: f.start,
          end_at: f.end,
          title: 'Ordinary insert before mode conversion',
          source: 'web',
        })
        let finished = false
        result = conversion
          .query(`UPDATE event_types SET booking_mode='group',group_capacity=3 WHERE id=$1`, [
            f.event,
          ])
          .then(
            () => ({ code: undefined }),
            (error: unknown) => ({ code: (error as { code?: string }).code }),
          )
          .finally(() => {
            finished = true
          })
        // Observe the exact second backend, rather than assuming that a delay means
        // the conversion waited. KEY SHARE alone does not conflict with this UPDATE.
        let blocked = false
        for (let probe = 0; probe < 100 && !finished; probe++) {
          const state = (
            await f.pool.query<{ wait_event_type: string | null; wait_event: string | null }>(
              'SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()',
              [pids[1]],
            )
          ).rows[0]
          if (state?.wait_event_type === 'Lock' && state.wait_event === 'advisory') {
            blocked = true
            break
          }
        }
        expect(
          blocked,
          'mode conversion must wait for the in-flight ordinary booking advisory fence',
        ).toBe(true)
        await writer.query('COMMIT')
        expect(await result).toEqual({ code: '23514' })
        await conversion.query('ROLLBACK')
        expect(
          (
            await f.pool.query('SELECT booking_mode,group_capacity FROM event_types WHERE id=$1', [
              f.event,
            ])
          ).rows,
        ).toEqual([{ booking_mode: 'individual', group_capacity: null }])
        expect(
          (
            await f.pool.query('SELECT count(*)::int AS n FROM bookings WHERE event_type_id=$1', [
              f.event,
            ])
          ).rows,
        ).toEqual([{ n: 1 }])
      } finally {
        // Roll back the writer first so even a failed wait assertion releases the
        // conversion. Both the original and source-copy mutant close every client.
        try {
          await writer.query('ROLLBACK')
          await result
          await conversion?.query('ROLLBACK')
        } finally {
          writer.release()
          conversion?.release()
        }
      }
    }
    expect(pool.totalCount).toBeLessThanOrEqual(2)
    expect(initial.pool.totalCount).toBeLessThanOrEqual(2)
  } finally {
    await pool.end()
  }
}
