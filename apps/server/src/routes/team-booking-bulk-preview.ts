import { createRoute, z } from '@hono/zod-openapi'
import {
  BULK_BOOKING_PREVIEW_CODES,
  DomainError,
  teamBookingBulkPreview,
} from '@hourmere/scheduling'
import { createMiddleware } from 'hono/factory'
import { sql } from 'kysely'
import type { CallerEnv } from '../caller.ts'
import { ErrorBody, json, type RouteModule, type ServiceDeps } from '../openapi.ts'
import {
  BulkPreviewSelectionSchema,
  bulkPageBinding,
  databaseWallTime,
  verifyBulkPageSelection,
} from '../team-booking-bulk-proof.ts'
import {
  EXPECTED_ORGANIZATION_HEADER,
  ORGANIZATION_CONTEXT_CHANGED,
  teamManagementAccess,
} from '../team-management.ts'

const BulkCancellationPreview = z
  .object({
    confirmationId: z.uuid(),
    expiresAt: z.iso.datetime(),
    items: z.array(
      z.object({
        bookingId: z.uuid(),
        code: z.enum(BULK_BOOKING_PREVIEW_CODES),
      }),
    ),
  })
  .openapi('BulkCancellationPreview')

/** Only test composition supplies a proof secret until the release gate is implemented. */
export function teamBookingBulkPreviewRoutes(
  deps: ServiceDeps & { bulkSelectionSecret?: string },
): RouteModule {
  return ({ app, caller }) => {
    const { db, bulkSelectionSecret } = deps
    const access = teamManagementAccess(db, caller)
    const hardOff = createMiddleware<CallerEnv>(async (c, next) => {
      if (!bulkSelectionSecret) return c.json({ error: 'not_found' }, 404)
      await next()
    })
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/team/bookings/bulk-cancellations/preview',
        operationId: 'previewTeamBookingBulkCancellation',
        summary: 'Preview cancellation of bookings selected from one team booking page',
        description:
          'Unavailable until bulk cancellation is released. A current verified team owner/admin browser session and same-origin Origin or Referer are required. Preview records the ordered selection and eligibility without cancelling bookings or queuing notifications.',
        tags: ['Team bookings'],
        security: [{ session: [] }],
        middleware: [hardOff, ...access.middleware] as [
          typeof hardOff,
          ...typeof access.middleware,
        ],
        request: {
          headers: z.object({
            'x-expected-organization-id': z
              .string()
              .optional()
              .openapi({
                description: 'Required: the organization where the selection started',
                param: { required: true },
              }),
          }),
          body: { required: true, content: json(BulkPreviewSelectionSchema) },
        },
        responses: {
          200: {
            description: 'Preview with an expiring server-generated confirmation ID',
            content: json(BulkCancellationPreview),
          },
          400: {
            description: 'invalid_request: select 1 to 25 distinct booking IDs',
            content: json(ErrorBody),
          },
          403: {
            description:
              'team_management_access_denied: requires a current team owner/admin session without Authorization; forbidden: cookie writes require same-origin Origin or Referer',
            content: json(ErrorBody),
          },
          404: { description: 'Bulk cancellation is unavailable', content: json(ErrorBody) },
          409: {
            description: `${ORGANIZATION_CONTEXT_CHANGED}; bulk_selection_changed: reload the booking page and select again`,
            content: json(ErrorBody),
          },
          413: { description: 'Request body is too large', content: json(ErrorBody) },
        },
      }),
      async (c) => {
        if (!bulkSelectionSecret) return c.json({ error: 'not_found' }, 404)
        const principal = c.var.principal
        const { pageToken, bookingIds } = c.req.valid('json')
        const preview = await access.write(
          principal,
          principal.organization.id,
          async (trx, actor) => {
            const binding = bulkPageBinding(principal, actor)
            const proof = verifyBulkPageSelection(
              bulkSelectionSecret,
              binding,
              pageToken,
              bookingIds,
              await databaseWallTime(trx),
            )
            const items = await teamBookingBulkPreview(trx, actor.organizationId, proof.bookingIds)
            const expiresAt = proof.expiresAt
            const receipt = await trx
              .with('preview_clock', (db) =>
                db.selectNoFrom(sql<Date>`clock_timestamp()`.as('now')),
              )
              .insertInto('team_booking_bulk_cancellations')
              .columns([
                'organization_id',
                'actor_user_id',
                'session_id',
                'created_at',
                'expires_at',
              ])
              .expression((eb) =>
                eb
                  .selectFrom('preview_clock')
                  .select([
                    eb.val(actor.organizationId).as('organization_id'),
                    eb.val(actor.userId).as('actor_user_id'),
                    eb.val(binding.sessionId).as('session_id'),
                    'preview_clock.now',
                    eb.val(expiresAt).as('expires_at'),
                  ])
                  .where('now', '<', expiresAt),
              )
              .returning('id')
              .executeTakeFirst()
            if (!receipt) throw new DomainError('conflict', 'bulk_selection_changed')
            await trx
              .insertInto('team_booking_bulk_cancellation_items')
              .values(
                items.map((item, index) => ({
                  batch_id: receipt.id,
                  ordinal: index + 1,
                  booking_id: item.bookingId,
                  preview_outcome: item.code,
                })),
              )
              .execute()
            return { confirmationId: receipt.id, expiresAt: expiresAt.toISOString(), items }
          },
          { expectedOrganizationId: c.req.header(EXPECTED_ORGANIZATION_HEADER) ?? '' },
        )
        return c.json(preview, 200)
      },
      (result, c) => {
        if (!result.success) return c.json({ error: 'invalid_request' }, 400)
      },
    )
  }
}
