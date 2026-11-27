import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { Db } from '../../packages/db/src/index.ts'
import type { Fixtures } from '../../packages/scheduling/src/testing.ts'

export function teamBookingBulkFixture(
  db: Db,
  fixtures: Fixtures,
  team: string,
  manager: string,
  secondMember: string,
) {
  return {
    async seed(titles: string[], { paidIndex }: { paidIndex?: number } = {}) {
      const start = Temporal.Now.instant().add({ hours: 48 })
      const rows = []
      for (const [index, title] of titles.entries()) {
        const eventTypeId = await fixtures.eventType(team, null, {
          title,
          hosts: [{ userId: manager }],
        })
        const from = start.add({ hours: index })
        const booking = await fixtures.booking(
          team,
          [manager],
          from.toString(),
          from.add({ minutes: 30 }).toString(),
          {
            eventTypeId,
            attendee: { name: `Fixture invitee ${index + 1}`, email: 'invitee@hourmere.invalid' },
          },
        )
        rows.push({ id: booking, title })
        if (index === paidIndex) {
          // Paid events are personal-only. A retained Checkout association on a successor
          // exercises the team bulk safeguard with the stored historical binding.
          const earlier = await fixtures.booking(
            team,
            [manager],
            start.subtract({ hours: 72 }).toString(),
            start.subtract({ hours: 71, minutes: 30 }).toString(),
            { eventTypeId, status: 'cancelled', attendee: null },
          )
          await db
            .updateTable('bookings')
            .set({ rescheduled_from_id: earlier })
            .where('id', '=', booking)
            .execute()
          await db
            .insertInto('payment_checkout_attempts')
            .values({
              id: randomUUID(),
              booking_id: earlier,
              current_booking_id: booking,
              account_id: 'acct_synthetic_bulk_browser',
              amount_minor: 1000,
              currency: 'usd',
              mode: 'test',
              idempotency_key: randomUUID(),
            })
            .execute()
        }
      }
      return rows
    },
    async blockCancellation(id: string) {
      // A CHECK violation causes the actual worker's item transaction to roll back. The
      // constraint is in the helper-owned DB and the generated ID is its sole target.
      const booking = await db
        .selectFrom('bookings')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      await sql`ALTER TABLE bookings ADD CONSTRAINT fixture_partial_bulk_failure
        CHECK (id <> ${sql.lit(booking.id)}::uuid OR status <> 'cancelled') NOT VALID`.execute(db)
    },
    async unblockCancellation() {
      await sql`ALTER TABLE bookings DROP CONSTRAINT fixture_partial_bulk_failure`.execute(db)
    },
    async setActorRole(role: 'admin' | 'member') {
      // Preserve a separate owner when exercising admin and revoked browser sessions.
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('auth.member')
          .set({ role: 'owner' })
          .where('organizationId', '=', team)
          .where('userId', '=', secondMember)
          .execute()
        await trx
          .updateTable('auth.member')
          .set({ role })
          .where('organizationId', '=', team)
          .where('userId', '=', manager)
          .execute()
      })
    },
    async effects(id: string) {
      const [audit, items, refunds] = await Promise.all([
        db
          .selectFrom('audit_events')
          .select(['action', 'target_id'])
          .where('request_id', '=', id)
          .orderBy('action')
          .execute(),
        db
          .selectFrom('team_booking_bulk_cancellation_items')
          .select(['booking_id', 'outcome'])
          .where('batch_id', '=', id)
          .orderBy('ordinal')
          .execute(),
        db.selectFrom('payment_refund_obligations').select('id').execute(),
      ])
      return { audit, items, refunds: refunds.length }
    },
    async statuses(ids: string[]) {
      const rows = await db
        .selectFrom('bookings')
        .select(['id', 'status'])
        .where('organization_id', '=', team)
        .where('id', 'in', ids)
        .execute()
      const statuses = new Map(rows.map(({ id, status }) => [id, status]))
      return ids.map((id) => statuses.get(id))
    },
  }
}
