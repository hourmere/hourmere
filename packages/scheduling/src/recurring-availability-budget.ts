import type { Db } from '@hourmere/db'
import { type Expression, sql } from 'kysely'
import { DomainError } from './errors.ts'

export const MAX_RECURRING_AVAILABILITY_EVALUATIONS = 96
export const MAX_RECURRING_AVAILABILITY_READS = 32
export const MAX_RECURRING_AVAILABILITY_ROWS = 10_000
export const RECURRING_AVAILABILITY_DEADLINE_MS = 5_000

export interface RecurringAvailabilityMetrics {
  reads: number
  rows: number
  evaluations: number
}

function checkUnavailable() {
  return new DomainError(
    'unavailable',
    'series_check_unavailable',
    'Series availability is temporarily unavailable. Try again shortly.',
  )
}

/** Use the same connection for every fact read, including when a caller already holds locks. */
export async function withRecurringAvailabilityBudget<T>(
  db: Db,
  check: (db: Db, budget: RecurringAvailabilityBudget) => Promise<T>,
): Promise<T> {
  const deadline = performance.now() + RECURRING_AVAILABILITY_DEADLINE_MS
  const remaining = () => {
    const ms = Math.floor(deadline - performance.now())
    if (ms <= 0) throw checkUnavailable()
    return ms
  }
  const run = async (connection: Db) => {
    const budget = new RecurringAvailabilityBudget(connection, remaining)
    await budget.initialize()
    const result = await check(connection, budget)
    remaining()
    return result
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (db.isTransaction) {
      // Roll back only the read-only work and its SET LOCAL changes. This also recovers
      // a caller's transaction from a statement timeout without releasing its prior locks.
      await sql`SAVEPOINT recurring_availability`.execute(db)
      try {
        return await run(db)
      } finally {
        await sql`ROLLBACK TO SAVEPOINT recurring_availability`.execute(db)
        await sql`RELEASE SAVEPOINT recurring_availability`.execute(db)
      }
    }

    let connected = false
    const acquireDeadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (!connected) reject(checkUnavailable())
      }, RECURRING_AVAILABILITY_DEADLINE_MS)
    })
    const batch = db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute((connection) => {
        connected = true
        remaining()
        return run(connection)
      })
    return await Promise.race([batch, acquireDeadline])
  } catch (error) {
    // PostgreSQL cancels the active statement. Awaiting the transaction also releases
    // the checked-out connection before propagating the error.
    if ((error as { code?: string } | null)?.code === '57014') throw checkUnavailable()
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export class RecurringAvailabilityBudget {
  readonly metrics: RecurringAvailabilityMetrics = { reads: 0, rows: 0, evaluations: 0 }
  private statementTimeout = Number.POSITIVE_INFINITY
  private readonly db: Db
  private readonly remaining: () => number

  constructor(db: Db, remaining: () => number) {
    this.db = db
    this.remaining = remaining
  }

  async initialize(): Promise<void> {
    // Preserve a shorter timeout already set by the caller.
    const [row] = await this.read(
      sql<{ setting: string }>`(select setting from pg_settings where name = 'statement_timeout')`,
      false,
    )
    this.statementTimeout = Number(row?.setting) || Number.POSITIVE_INFINITY
  }

  async read<Row>(query: Expression<Row>, setTimeout = true): Promise<Row[]> {
    const time = Math.min(this.remaining(), this.statementTimeout)
    const room = MAX_RECURRING_AVAILABILITY_ROWS - this.metrics.rows
    if (this.metrics.reads >= MAX_RECURRING_AVAILABILITY_READS || room <= 0)
      throw checkUnavailable()
    if (setTimeout) {
      await sql`SET LOCAL statement_timeout = ${sql.lit(time)}`.execute(this.db)
      this.remaining()
    }
    this.metrics.reads++
    // The inner cap limits database work needed to detect overflow. The outer cap
    // keeps the extra sentinel row on the server, even when the batch is too dense.
    const { rows } = await sql<Row & { batch_row_count: number }>`
      select facts.*, count(*) over ()::int as batch_row_count
      from (select * from ${query} as unbounded_facts limit ${room + 1}) as facts
      limit ${room}
    `.execute(this.db)
    this.metrics.rows += rows.length
    this.remaining()
    if ((rows[0]?.batch_row_count ?? 0) > room) throw checkUnavailable()
    return rows
  }

  evaluate(): void {
    this.remaining()
    if (++this.metrics.evaluations > MAX_RECURRING_AVAILABILITY_EVALUATIONS)
      throw checkUnavailable()
  }
}
