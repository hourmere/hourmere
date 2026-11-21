import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { WORKFLOW_HISTORY_DAYS } from './limits.ts'

export const WORKFLOW_RETENTION_BATCH = 100
export const workflowHistoryCutoff = sql<Date>`transaction_timestamp() - make_interval(hours => ${24 * WORKFLOW_HISTORY_DAYS})`

/** One batch per table. Enrollment identities, delivery ledgers and audit events survive. */
export async function purgeWorkflowHistory(db: Db): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`SET LOCAL lock_timeout = '1s'`.execute(trx)
    await sql`SET LOCAL statement_timeout = '20s'`.execute(trx)
    await trx
      .deleteFrom('workflow_runs')
      .where('id', 'in', (eb) =>
        eb
          .selectFrom('workflow_runs as run')
          .select('run.id')
          .where('run.state', 'in', ['completed', 'skipped', 'retired'])
          .where('run.finished_at', '<', workflowHistoryCutoff)
          // Give interrupted email attempts a chance to record their final audit outcome.
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('workflow_recipient_claims')
                  .select('id')
                  .whereRef('organization_id', '=', 'run.organization_id')
                  .whereRef('run_id', '=', 'run.id')
                  .whereRef('booking_id', '=', 'run.booking_id')
                  .where('state', '=', 'dispatching'),
              ),
            ),
          )
          // The webhook outbox still uses the run for eligibility and audit reconciliation.
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('webhook_deliveries')
                  .select('id')
                  .whereRef('workflow_run_id', '=', 'run.id')
                  .whereRef('organization_id', '=', 'run.organization_id')
                  .whereRef('booking_id', '=', 'run.booking_id')
                  .where('status', '=', sql.lit('pending')),
              ),
            ),
          )
          .orderBy('run.finished_at')
          .orderBy('run.id')
          .limit(WORKFLOW_RETENTION_BATCH)
          .forUpdate()
          .skipLocked(),
      )
      .execute()
    await trx
      .deleteFrom('workflow_run_history')
      .where('run_id', 'in', (eb) =>
        eb
          .selectFrom('workflow_run_history')
          .select('run_id')
          .where('finished_at', '<', workflowHistoryCutoff)
          .orderBy('finished_at')
          .orderBy('run_id')
          .limit(WORKFLOW_RETENTION_BATCH)
          .forUpdate()
          .skipLocked(),
      )
      .execute()
  })
}
