import { checkTeamManagementAccess, TeamManagementError } from '@hourmere/auth'
import { sql } from 'kysely'
import { bookingPageQuery, encodeBookingCursor } from './booking-page.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { resolvedBookingHosts } from './hosts.ts'
import { isUuid, validTimeZone } from './internal.ts'

export const MAX_EXPORT_DAYS = 366
export const EXPORT_PAGE_SIZE = 100
export const EXPORT_TIMEOUT_MS = 300_000
export const EXPORT_STALL_TIMEOUT_MS = 30_000
let activeExports = 0

function exportConcurrencyLimit(): number {
  const configured = Number(process.env.BOOKING_EXPORT_MAX_CONCURRENT)
  return Number.isInteger(configured) && configured >= 1 && configured <= 8 ? configured : 2
}
export interface BookingExportInput {
  from: string
  to: string
  timeZone?: string | undefined
  bom?: boolean | undefined
  status?: 'confirmed' | 'cancelled' | undefined
  eventTypeId?: string | undefined
  hostUserId?: string | undefined
  endAfter?: string | undefined
  endTo?: string | undefined
  order?: 'asc' | 'desc' | undefined
  expectedOrganizationId?: string | undefined
}

/** Formula protection precedes RFC 4180 quoting, including leading Unicode whitespace. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value)
  if (/(^|[;,])\s*[=+\-@\t\r]/u.test(text)) text = `'${text}`
  text = text.replace(/;(\s*[=+\-@\t\r])/gu, ";'$1")
  return /[";,\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export const BOOKING_EXPORT_COLUMNS = [
  'id',
  'event_type_id',
  'event_type',
  'title',
  'start',
  'end',
  'start_utc',
  'end_utc',
  'status',
  'invitee_name',
  'invitee_email',
  'guests_count',
  'hosts',
  'location_option',
  'answers',
  'source',
  'created_at',
  'cancelled_at',
  'time_zone',
] as const

/** The existing team-admin read whitelist; private host-only fields never become CSV columns. */
export const TEAM_BOOKING_EXPORT_COLUMNS = [
  'id',
  'event_type_id',
  'event_type',
  'start',
  'end',
  'start_utc',
  'end_utc',
  'status',
  'invitee_name',
  'invitee_email',
  'guests_count',
  'hosts',
  'cancelled_at',
  'time_zone',
] as const

export async function prepareBookingExport(ctx: ServiceContext, input: BookingExportInput) {
  const timeZone = validTimeZone(input.timeZone ?? 'UTC')
  try {
    const from = Temporal.Instant.from(input.from)
    const to = Temporal.Instant.from(input.to)
    const duration = to.epochNanoseconds - from.epochNanoseconds
    if (duration <= 0n || duration > BigInt(MAX_EXPORT_DAYS) * 86_400_000_000_000n)
      throw new Error('range')
    for (const instant of [input.endAfter, input.endTo])
      if (instant !== undefined) Temporal.Instant.from(instant)
    if (input.endAfter && input.endTo && Temporal.Instant.compare(input.endAfter, input.endTo) >= 0)
      throw new Error('range')
    if (input.status !== undefined && !['confirmed', 'cancelled'].includes(input.status))
      throw new Error('status')
    if (input.order !== undefined && !['asc', 'desc'].includes(input.order))
      throw new Error('order')
    if (input.bom !== undefined && typeof input.bom !== 'boolean') throw new Error('bom')
    for (const id of [input.eventTypeId, input.hostUserId, input.expectedOrganizationId])
      if (id !== undefined && !isUuid(id)) throw new Error('id')
  } catch {
    throw new DomainError(
      'invalid',
      'invalid_export_range',
      'Choose valid filters and a range of at most 366 days',
    )
  }
  if (
    input.expectedOrganizationId &&
    input.expectedOrganizationId.toLowerCase() !== ctx.principal.organization.id.toLowerCase()
  )
    throw new DomainError(
      'conflict',
      'organization_context_changed',
      'Your organization context changed. Reload before exporting.',
    )
  const personal = await ctx.db
    .selectFrom('personal_organizations')
    .select('user_id')
    .where('organization_id', '=', ctx.principal.organization.id)
    .executeTakeFirst()
  if (personal) {
    const member = await ctx.db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', ctx.principal.organization.id)
      .where('userId', '=', ctx.principal.user.id)
      .executeTakeFirst()
    if (personal.user_id !== ctx.principal.user.id || !member)
      throw new DomainError(
        'forbidden',
        'insufficient_role',
        'Only personal owners may export their bookings',
      )
  } else {
    try {
      await checkTeamManagementAccess(ctx.db, ctx.principal, ctx.principal.organization.id, false, {
        expectedOrganizationId: ctx.principal.organization.id,
        allowPersonal: false,
      })
    } catch (error) {
      if (!(error instanceof TeamManagementError)) throw error
      throw new DomainError(
        error.code === 'organization_context_changed' ? 'conflict' : 'forbidden',
        error.code,
      )
    }
  }
  return { ...input, timeZone, bom: input.bom ?? false, teamScope: !personal }
}

/** Escape semicolons in JSON strings without changing their decoded values. */
function exportJson(value: unknown): string {
  return JSON.stringify(value).replaceAll(';', '\\u003b')
}

function locationMetadata(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const obj = value as Record<string, unknown>
  return exportJson(
    Object.fromEntries(
      ['id', 'kind', 'label']
        .filter((key) => typeof obj[key] === 'string')
        .map((key) => [key, obj[key]]),
    ),
  )
}

/** A bounded, backpressured stream with one repeatable-read snapshot and one DB lease per org. */
export async function exportBookingsCsv(
  ctx: ServiceContext,
  input: BookingExportInput,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  // Reserve synchronously before acquiring any connection, including for permission checks.
  if (activeExports >= exportConcurrencyLimit())
    throw new DomainError(
      'conflict',
      'export_busy',
      'Too many exports are running. Try again shortly.',
    )
  activeExports++
  const ready = Promise.withResolvers<ReadableStream<Uint8Array>>()
  const done = Promise.withResolvers<void>()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  const armStallTimer = () => {
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => {
      controller?.error(new Error('CSV export reader timed out'))
      finish()
    }, EXPORT_STALL_TIMEOUT_MS)
    stallTimer.unref()
  }
  const abort = () => {
    if (stopped) return
    controller?.error(new Error('CSV export aborted'))
    finish()
  }
  const finish = () => {
    signal?.removeEventListener('abort', abort)
    stopped = true
    clearTimeout(timer)
    clearTimeout(stallTimer)
    done.resolve()
  }
  const transaction = ctx.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const options = await prepareBookingExport({ ...ctx, db: trx }, input)
      // Transaction-scoped lock releases on failure, disconnect, timeout and normal completion.
      const lock = await sql<{
        acquired: boolean
      }>`SELECT pg_try_advisory_xact_lock(hashtextextended(${`booking-export:${ctx.principal.organization.id}`}, 0)) AS acquired`.execute(
        trx,
      )
      if (!lock.rows[0]?.acquired)
        throw new DomainError(
          'conflict',
          'export_in_progress',
          'An export is already running for this organization',
        )
      await sql`SET LOCAL statement_timeout = '30s'`.execute(trx)
      const encoder = new TextEncoder()
      async function* rows() {
        const columns = options.teamScope ? TEAM_BOOKING_EXPORT_COLUMNS : BOOKING_EXPORT_COLUMNS
        yield `${options.bom ? '\uFEFF' : ''}${columns.join(',')}\r\n`
        let cursor: string | undefined
        do {
          const { query } = bookingPageQuery(trx, {
            from: Temporal.Instant.from(options.from),
            to: Temporal.Instant.from(options.to),
            endAfter: options.endAfter ? Temporal.Instant.from(options.endAfter) : undefined,
            endTo: options.endTo ? Temporal.Instant.from(options.endTo) : undefined,
            status: options.status,
            order: options.order,
            limit: EXPORT_PAGE_SIZE,
            cursor,
          })
          const page = await query
            .leftJoin('event_types as e', 'e.id', 'b.event_type_id')
            .where('b.organization_id', '=', ctx.principal.organization.id)
            .$if(options.eventTypeId !== undefined, (q) =>
              q.where('b.event_type_id', '=', options.eventTypeId as string),
            )
            .$if(options.hostUserId !== undefined, (q) =>
              q.where((eb) =>
                eb.exists(
                  eb
                    .selectFrom(resolvedBookingHosts(trx).as('export_host'))
                    .select('booking_id')
                    .whereRef('booking_id', '=', 'b.id')
                    .where('user_id', '=', options.hostUserId as string),
                ),
              ),
            )
            .select([
              'b.id',
              'b.event_type_id',
              sql<string | null>`CASE WHEN e.deleted_at IS NULL THEN e.title ELSE NULL END`.as(
                'event_type',
              ),
              'b.title',
              'b.end_at',
              'b.status',
              'b.location_option',
              'b.location',
              'b.responses',
              'b.source',
              'b.created_at',
              'b.cancelled_at',
            ])
            .select(
              sql<string>`to_char(timezone('UTC', b.end_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
                'end_utc',
              ),
            )
            .limit(EXPORT_PAGE_SIZE)
            .execute()
          if (stopped || !page.length) break
          const ids = page.map((row) => row.id)
          const attendees = await trx
            .selectFrom('booking_attendees')
            .select(['booking_id', 'name', 'email', 'is_booker'])
            .where('booking_id', 'in', ids)
            .orderBy('id')
            .execute()
          if (stopped) return
          const hosts = await trx
            .selectFrom(resolvedBookingHosts(trx).as('h'))
            .innerJoin('auth.user as u', 'u.id', 'h.user_id')
            .select(['h.booking_id', 'u.id', 'u.name'])
            .select(options.teamScope ? sql<string | null>`NULL`.as('email') : 'u.email')
            .where('h.booking_id', 'in', ids)
            .orderBy('u.id')
            .execute()
          for (const row of page) {
            if (stopped) return
            const start = Temporal.Instant.from(row.cursor_start)
            const end = Temporal.Instant.from(row.end_utc)
            const people = attendees.filter((person) => person.booking_id === row.id)
            const invitee = people.find((person) => person.is_booker)
            const values: Record<string, unknown> = {
              id: row.id,
              event_type_id: row.event_type_id,
              event_type: row.event_type,
              title: row.title,
              start: start.toZonedDateTimeISO(options.timeZone).toString({ timeZoneName: 'never' }),
              end: end.toZonedDateTimeISO(options.timeZone).toString({ timeZoneName: 'never' }),
              start_utc: start.toString(),
              end_utc: end.toString(),
              status: row.status,
              invitee_name: invitee?.name,
              invitee_email: invitee?.email,
              guests_count: people.filter((person) => !person.is_booker).length,
              hosts: exportJson(
                hosts
                  .filter((host) => host.booking_id === row.id)
                  .map(({ id, name, email }) =>
                    options.teamScope ? { id, name } : { id, name, email },
                  ),
              ),
              location_option: locationMetadata(row.location_option ?? row.location),
              answers: exportJson(row.responses),
              source: row.source,
              created_at: row.created_at.toISOString(),
              cancelled_at: row.cancelled_at?.toISOString(),
              time_zone: options.timeZone,
            }
            yield `${columns
              .map((column) => values[column])
              .map(csvCell)
              .join(',')}\r\n`
          }
          const last = page.at(-1)
          if (!last) break
          cursor = encodeBookingCursor(last)
          if (page.length < EXPORT_PAGE_SIZE) break
        } while (!stopped)
      }
      const iterator = rows()
      const stream = new ReadableStream<Uint8Array>(
        {
          start(c) {
            controller = c
          },
          async pull(c) {
            clearTimeout(stallTimer)
            try {
              const row = await iterator.next()
              if (stopped) return
              if (row.done) {
                finish()
                await transaction
                c.close()
              } else {
                c.enqueue(encoder.encode(row.value))
                armStallTimer()
              }
            } catch (error) {
              c.error(error)
              finish()
            }
          },
          async cancel() {
            finish()
            await transaction
          },
        },
        { highWaterMark: 0 },
      )
      timer = setTimeout(() => {
        controller?.error(new Error('CSV export timed out'))
        finish()
      }, EXPORT_TIMEOUT_MS)
      timer.unref()
      armStallTimer()
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      ready.resolve(stream)
      await done.promise
    })
    .catch((error) => {
      ready.reject(error)
      if (!stopped) controller?.error(error)
      finish()
    })
    .finally(() => {
      activeExports--
    })
  return ready.promise
}
