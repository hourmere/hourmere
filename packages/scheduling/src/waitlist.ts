// Internal waitlist admission and capability services. No sender, route or provider calls.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { isIP } from 'node:net'
import { interfaceLanguage } from '@hourmere/core/language'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { z } from 'zod'
import {
  findPublicEventType,
  findPublicTeamEventType,
  listPublicSlots,
  listPublicTeamSlots,
  type PublicEventTypeRecord,
} from './availability.ts'
import type { PublicContext } from './context.ts'
import { DomainError } from './errors.ts'
import { cleanText } from './text.ts'

export interface WaitlistContext extends Omit<PublicContext, 'now'> {
  secret: string
  publicUrl: string
  /** Resolved by the trusted transport, never copied from invitee input/headers. */
  trustedIp?: string | undefined
  /** Test clock only. Production reads the database clock after lock waits. */
  now?: (() => Temporal.Instant) | undefined
}

export interface WaitlistEventReference {
  handle: string
  slug: string
  team?: boolean | undefined
}
export interface JoinWaitlistInput extends WaitlistEventReference {
  email: string
  name?: string | undefined
  preferredWindow: { start: string; end: string; timeZone: string }
  locale?: string | undefined
  consent: true
}

const LIVE = ['pending_verification', 'active', 'notified']
const HOUR = 3_600_000
const DAY = 24 * HOUR
const accepted = () => ({ accepted: true as const })
const invalidToken = () => new DomainError('not_found', 'invalid_waitlist_token')
const invalidInput = () => new DomainError('invalid', 'invalid_waitlist_input')

export class WaitlistRateLimitError extends Error {
  readonly code = 'rate_limited'
  readonly retryAfterSeconds: number
  constructor(retryAfterSeconds: number) {
    super('rate_limited')
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** Same booking-recipient purpose as the independent notification send ledger. */
export function waitlistRecipientHash(email: string, secret: string): Buffer {
  const key = createHmac('sha256', secret)
    .update('hourmere/notification-recipient-hash/v1')
    .digest()
  return createHmac('sha256', key).update(`booking\0${email.trim().toLowerCase()}`).digest()
}

function admissionHash(value: string, secret: string, purpose: 'email' | 'ip'): Buffer {
  const key = createHmac('sha256', secret).update('hourmere/waitlist-admission/v1').digest()
  return createHmac('sha256', key).update(`${purpose}\0${value}`).digest()
}

/** IPv6 textual aliases and address rotation within a /64 share one durable bucket. */
export function waitlistIpBucket(value: string | undefined): string {
  const kind = value && isIP(value)
  if (kind === 4) return value as string
  if (kind !== 6) return 'unknown'
  const address = new URL(`http://[${value}]/`).hostname.slice(1, -1)
  // URL canonicalization expands mapped IPv4 addresses into hex groups as well.
  const [left, right] = address.split('::')
  const prefix = left ? left.split(':') : []
  const suffix = right ? right.split(':') : []
  const groups =
    right === undefined
      ? prefix
      : [...prefix, ...Array(8 - prefix.length - suffix.length).fill('0'), ...suffix]
  return `${groups
    .slice(0, 4)
    .map((part) => Number.parseInt(part, 16).toString(16))
    .join(':')}::/64`
}

export function waitlistTokenHash(token: string, purpose: 'verification' | 'management'): Buffer {
  return createHash('sha256')
    .update(`hourmere/waitlist-capability/v1\0${purpose}\0${token}`)
    .digest()
}
const tokenValue = (entryId: string) => `${entryId}.${randomBytes(32).toString('base64url')}`
const validTokenShape = (token: unknown): token is string =>
  typeof token === 'string' && /^[a-f\d-]{36}\.[A-Za-z0-9_-]{43}$/.test(token)

export async function waitlistNow(db: Db, override?: Date): Promise<Date> {
  const now =
    override ?? (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(db)).rows[0]?.now
  if (!now) throw new Error('Waitlist requires the database clock')
  return now
}

/** All readers hold this key fence through commit. Rotation never locks event/host rows. */
export async function ensureWaitlistKey(db: Db, secret: string, at?: Date): Promise<void> {
  if (!db.isTransaction) throw new Error('Waitlist key checks need a transaction')
  const fingerprint = createHmac('sha256', secret)
    .update('hourmere/waitlist-key-version/v1')
    .digest()
  const before = await db
    .selectFrom('waitlist_key_state')
    .select('secret_fingerprint')
    .executeTakeFirst()
  const same = before?.secret_fingerprint.equals(fingerprint)
  if (same) await sql`SELECT pg_advisory_xact_lock_shared(1752658796, 1801812326)`.execute(db)
  else await sql`SELECT pg_advisory_xact_lock(1752658796, 1801812326)`.execute(db)
  const current = await db
    .selectFrom('waitlist_key_state')
    .select('secret_fingerprint')
    .executeTakeFirst()
  if (current?.secret_fingerprint.equals(fingerprint)) return
  if (same) throw new Error('Waitlist accounting key changed; retry')
  const now = await waitlistNow(db, at)
  // Removing a waiting entry invokes the DB erasure/revocation guard. Also erase terminal
  // contacts now: a changed key must leave no old contact or decryptable work behind.
  await db
    .updateTable('waitlist_entries')
    .set({ status: 'removed', terminal_reason: 'secret_rotated', terminal_at: now })
    .where('status', 'in', LIVE)
    .execute()
  await db
    .updateTable('waitlist_entries')
    .set({
      email: null,
      name: null,
      window_start: null,
      window_end: null,
      time_zone: null,
      locale: null,
    })
    .execute()
  await db.deleteFrom('waitlist_capabilities').execute()
  await db.deleteFrom('waitlist_verification_outbox').execute()
  await db
    .insertInto('waitlist_key_state')
    .values({ singleton: true, secret_fingerprint: fingerprint, updated_at: now })
    .onConflict((oc) =>
      oc.column('singleton').doUpdateSet({ secret_fingerprint: fingerprint, updated_at: now }),
    )
    .execute()
}

export async function resolveWaitlistEvent(
  db: Db,
  ref: WaitlistEventReference,
  lock = false,
): Promise<PublicEventTypeRecord> {
  let et = await (ref.team ? findPublicTeamEventType : findPublicEventType)(
    db,
    ref.handle,
    ref.slug,
  )
  if (!et) throw new DomainError('not_found', 'event_type_not_found')
  if (
    et.schedulingType !== 'individual' ||
    et.hostUserIds.length !== 1 ||
    et.eligibleHostUserIds.length !== 1
  )
    throw new DomainError('invalid', 'waitlist_unsupported')
  let query = db
    .selectFrom('event_types')
    .select(['waitlist_enabled', 'is_active', 'deleted_at'])
    .where('id', '=', et.id)
  if (lock) query = query.forUpdate()
  const row = await query.executeTakeFirst()
  if (!row?.is_active || row.deleted_at || !row.waitlist_enabled)
    throw new DomainError('conflict', 'waitlist_unavailable')
  if (lock) {
    et = await (ref.team ? findPublicTeamEventType : findPublicEventType)(
      db,
      ref.handle,
      ref.slug,
      { lock: true },
    )
    if (!et) throw new DomainError('not_found', 'event_type_not_found')
    if (
      et.schedulingType !== 'individual' ||
      et.hostUserIds.length !== 1 ||
      et.eligibleHostUserIds.length !== 1
    )
      throw new DomainError('invalid', 'waitlist_unsupported')
  }
  return et
}

export async function resolveWaitlistEventById(
  db: Db,
  eventTypeId: string,
): Promise<PublicEventTypeRecord | undefined> {
  const row = await db
    .selectFrom('event_types as et')
    .innerJoin('auth.organization as o', 'o.id', 'et.organization_id')
    .leftJoin('profiles as p', 'p.user_id', 'et.owner_user_id')
    .select(['et.slug', 'et.owner_user_id', 'p.handle', 'o.slug as team_slug'])
    .where('et.id', '=', eventTypeId)
    .executeTakeFirst()
  if (!row) return undefined
  try {
    return await resolveWaitlistEvent(db, {
      handle: row.owner_user_id ? (row.handle ?? '') : row.team_slug,
      slug: row.slug,
      team: !row.owner_user_id,
    })
  } catch (error) {
    if (error instanceof DomainError) return undefined
    throw error
  }
}

function emailValue(value: unknown): string {
  const email = cleanText(value, { max: 254 })?.toLowerCase()
  if (!email || !z.email().safeParse(email).success) throw invalidInput()
  return email
}
function parseInput(input: JoinWaitlistInput) {
  const email = emailValue(input.email)
  const name = input.name === undefined ? null : cleanText(input.name, { max: 200 })
  if (name === undefined || input.consent !== true) throw invalidInput()
  try {
    if (
      !/T.*(?:Z|[+-]\d\d:\d\d)$/i.test(input.preferredWindow.start) ||
      !/T.*(?:Z|[+-]\d\d:\d\d)$/i.test(input.preferredWindow.end)
    )
      throw invalidInput()
    const start = Temporal.Instant.from(input.preferredWindow.start)
    const end = Temporal.Instant.from(input.preferredWindow.end)
    const timeZone = input.preferredWindow.timeZone
    if (typeof timeZone !== 'string' || /^[+-]/.test(timeZone)) throw invalidInput()
    Temporal.Now.zonedDateTimeISO(timeZone)
    return {
      email,
      name,
      start: new Date(start.epochMilliseconds),
      end: new Date(end.epochMilliseconds),
      timeZone,
      locale: interfaceLanguage(input.locale) ?? 'en',
    }
  } catch {
    throw invalidInput()
  }
}
function checkWindow(start: Date, end: Date, now: Date) {
  if (
    start.getTime() < now.getTime() ||
    end <= start ||
    end.getTime() > now.getTime() + 62 * DAY ||
    end.getTime() - start.getTime() > 62 * DAY
  )
    throw new DomainError('invalid', 'invalid_waitlist_window')
}

/** Expiration is evaluated under the admission event lock, so delayed jobs cannot fill it. */
async function expireEventEntries(db: Db, eventId: string, now: Date) {
  await db
    .updateTable('waitlist_entries')
    .set({ status: 'expired', terminal_at: now, terminal_reason: 'deadline_reached' })
    .where('event_type_id', '=', eventId)
    .where('status', 'in', LIVE)
    .where((eb) =>
      eb.or([
        eb('expires_at', '<=', now),
        eb.and([eb('status', '=', 'pending_verification'), eb('pending_expires_at', '<=', now)]),
      ]),
    )
    .execute()
}

// One bounded advisory fence serializes all three rolling dimensions across replicas.
async function admissionBudget(
  db: Db,
  eventId: string,
  email: string,
  ip: string | undefined,
  secret: string,
  now: Date,
) {
  await sql`SELECT pg_advisory_xact_lock(1752658796, 1633969261)`.execute(db)
  const emailHash = admissionHash(email, secret, 'email')
  const ipHash = admissionHash(waitlistIpBucket(ip), secret, 'ip')
  const hour = new Date(now.getTime() - HOUR),
    day = new Date(now.getTime() - DAY)
  const counts = await db
    .selectFrom('waitlist_verification_requests')
    .select((eb) => [
      eb.fn.countAll<string>().filterWhere('email_hash', '=', emailHash).as('emailDay'),
      eb.fn
        .countAll<string>()
        .filterWhere('email_hash', '=', emailHash)
        .filterWhere('requested_at', '>', hour)
        .as('emailHour'),
      eb.fn.countAll<string>().filterWhere('ip_hash', '=', ipHash).as('ipDay'),
      eb.fn
        .countAll<string>()
        .filterWhere('ip_hash', '=', ipHash)
        .filterWhere('requested_at', '>', hour)
        .as('ipHour'),
      eb.fn.countAll<string>().filterWhere('event_type_id', '=', eventId).as('eventDay'),
      eb.fn
        .countAll<string>()
        .filterWhere('event_type_id', '=', eventId)
        .filterWhere('requested_at', '>', hour)
        .as('eventHour'),
    ])
    .where('requested_at', '>', day)
    .where((eb) =>
      eb.or([
        eb('email_hash', '=', emailHash),
        eb('ip_hash', '=', ipHash),
        eb('event_type_id', '=', eventId),
      ]),
    )
    .executeTakeFirstOrThrow()
  if (Number(counts.ipHour) >= 5 || Number(counts.ipDay) >= 20)
    throw new WaitlistRateLimitError(Number(counts.ipDay) >= 20 ? 86400 : 3600)
  return {
    allowed:
      Number(counts.emailHour) < 2 &&
      Number(counts.emailDay) < 5 &&
      Number(counts.eventHour) < 20 &&
      Number(counts.eventDay) < 100,
    emailHash,
    ipHash,
  }
}

const outboxKey = (secret: string) =>
  Buffer.from(hkdfSync('sha256', secret, 'Hourmere waitlist verification', 'outbox-v1', 32))
const outboxAad = (
  ctx: Pick<WaitlistContext, 'publicUrl'>,
  row: { id: string; entry_id: string; generation: number },
) =>
  Buffer.from(
    `hourmere:waitlist-verification:v1:${new URL(ctx.publicUrl).origin}:${row.id}:${row.entry_id}:${row.generation}`,
  )
function sealOutbox(
  ctx: WaitlistContext,
  row: { id: string; entry_id: string; generation: number },
  token: string,
) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', outboxKey(ctx.secret), iv)
  cipher.setAAD(outboxAad(ctx, row))
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ verificationToken: token }), 'utf8'),
    cipher.final(),
  ])
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted])
}
/** Internal sender utility: ciphertext is authenticated to origin, row, entry and generation. */
export function openWaitlistVerificationOutbox(
  ctx: Pick<WaitlistContext, 'secret' | 'publicUrl'>,
  row: { id: string; entry_id: string; generation: number; encrypted_payload: Buffer | null },
): { verificationToken: string } | undefined {
  try {
    const value = row.encrypted_payload
    if (!value || value.length < 30 || value.length > 4096 || value[0] !== 1) return undefined
    const decipher = createDecipheriv('aes-256-gcm', outboxKey(ctx.secret), value.subarray(1, 13))
    decipher.setAAD(outboxAad(ctx, row))
    decipher.setAuthTag(value.subarray(13, 29))
    const parsed: unknown = JSON.parse(
      Buffer.concat([decipher.update(value.subarray(29)), decipher.final()]).toString('utf8'),
    )
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('verificationToken' in parsed) ||
      !validTokenShape(parsed.verificationToken)
    )
      return undefined
    return { verificationToken: parsed.verificationToken }
  } catch {
    return undefined
  }
}

async function generation(
  db: Db,
  ctx: WaitlistContext,
  entry: {
    id: string
    verification_generation: number
    pending_expires_at: Date
    expires_at: Date
  },
  budget: { emailHash: Buffer; ipHash: Buffer },
  eventId: string,
  now: Date,
) {
  const id = randomUUID(),
    token = tokenValue(entry.id)
  const expiresAt = new Date(
    Math.min(
      now.getTime() + 30 * 60_000,
      entry.pending_expires_at.getTime(),
      entry.expires_at.getTime(),
    ),
  )
  await db
    .insertInto('waitlist_capabilities')
    .values({
      entry_id: entry.id,
      purpose: 'verification',
      token_hash: waitlistTokenHash(token, 'verification'),
      generation: entry.verification_generation,
      expires_at: expiresAt,
      created_at: now,
    })
    .execute()
  const row = { id, entry_id: entry.id, generation: entry.verification_generation }
  await db
    .insertInto('waitlist_verification_outbox')
    .values({
      ...row,
      encrypted_payload: sealOutbox(ctx, row, token),
      expires_at: expiresAt,
      created_at: now,
      updated_at: now,
      next_attempt_at: now,
    })
    .execute()
  await db
    .insertInto('waitlist_verification_requests')
    .values({
      event_type_id: eventId,
      email_hash: budget.emailHash,
      ip_hash: budget.ipHash,
      generation_id: id,
      requested_at: now,
    })
    .execute()
}

export async function joinWaitlist(
  ctx: WaitlistContext,
  input: JoinWaitlistInput,
): Promise<{ accepted: true }> {
  const parsed = parseInput(input)
  return ctx.db.transaction().execute(async (db) => {
    await ensureWaitlistKey(
      db,
      ctx.secret,
      ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined,
    )
    const et = await resolveWaitlistEvent(db, input, true)
    await sql`SELECT pg_advisory_xact_lock(1752658796, 1633969261)`.execute(db)
    const now = await waitlistNow(db, ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined)
    checkWindow(parsed.start, parsed.end, now)
    const slots = await (input.team ? listPublicTeamSlots : listPublicSlots)(
      { ...ctx, db, now: () => Temporal.Instant.fromEpochMilliseconds(now.getTime()) },
      {
        handle: input.handle,
        slug: input.slug,
        start: Temporal.Instant.fromEpochMilliseconds(parsed.start.getTime()),
        end: Temporal.Instant.fromEpochMilliseconds(parsed.end.getTime()),
      },
    )
    if (slots.length) throw new DomainError('conflict', 'availability_changed')
    await expireEventEntries(db, et.id, now)
    const budget = await admissionBudget(db, et.id, parsed.email, ctx.trustedIp, ctx.secret, now)
    if (!budget.allowed) return accepted()
    const recipientHash = waitlistRecipientHash(parsed.email, ctx.secret)
    const duplicate = await db
      .selectFrom('waitlist_entries')
      .select('id')
      .where('event_type_id', '=', et.id)
      .where('recipient_hash', '=', recipientHash)
      .where('status', 'in', LIVE)
      .executeTakeFirst()
    if (duplicate) return accepted()
    const count = await db
      .selectFrom('waitlist_entries')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('event_type_id', '=', et.id)
      .where('status', 'in', LIVE)
      .executeTakeFirstOrThrow()
    if (Number(count.n) >= 100) return accepted()
    const expiresAt = new Date(Math.min(now.getTime() + 30 * DAY, parsed.end.getTime()))
    const entry = await db
      .insertInto('waitlist_entries')
      .values({
        organization_id: et.organizationId,
        event_type_id: et.id,
        recipient_hash: recipientHash,
        email: parsed.email,
        name: parsed.name,
        window_start: parsed.start,
        window_end: parsed.end,
        time_zone: parsed.timeZone,
        locale: parsed.locale,
        consent_version: 'waitlist-v1',
        consented_at: now,
        created_at: now,
        expires_at: expiresAt,
        pending_expires_at: new Date(Math.min(now.getTime() + DAY, expiresAt.getTime())),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await generation(db, ctx, entry, budget, et.id, now)
    return accepted()
  })
}

export async function resendWaitlistVerification(
  ctx: WaitlistContext,
  input: WaitlistEventReference & { email: string },
): Promise<{ accepted: true }> {
  const email = emailValue(input.email)
  return ctx.db.transaction().execute(async (db) => {
    await ensureWaitlistKey(
      db,
      ctx.secret,
      ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined,
    )
    const et = await resolveWaitlistEvent(db, input, true)
    await sql`SELECT pg_advisory_xact_lock(1752658796, 1633969261)`.execute(db)
    const now = await waitlistNow(db, ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined)
    await expireEventEntries(db, et.id, now)
    const budget = await admissionBudget(db, et.id, email, ctx.trustedIp, ctx.secret, now)
    if (!budget.allowed) return accepted()
    const entry = await db
      .selectFrom('waitlist_entries')
      .selectAll()
      .where('event_type_id', '=', et.id)
      .where('recipient_hash', '=', waitlistRecipientHash(email, ctx.secret))
      .where('status', '=', 'pending_verification')
      .forUpdate()
      .executeTakeFirst()
    if (!entry) return accepted()
    const previous = await db
      .selectFrom('waitlist_verification_outbox')
      .select('created_at')
      .where('entry_id', '=', entry.id)
      .orderBy('generation', 'desc')
      .executeTakeFirst()
    if (previous && now.getTime() - previous.created_at.getTime() < 15 * 60_000) return accepted()
    await db
      .updateTable('waitlist_capabilities')
      .set({ revoked_at: now })
      .where('entry_id', '=', entry.id)
      .where('purpose', '=', 'verification')
      .where('revoked_at', 'is', null)
      .execute()
    await db
      .updateTable('waitlist_verification_outbox')
      .set({ state: 'superseded', encrypted_payload: null, updated_at: now })
      .where('entry_id', '=', entry.id)
      .where('state', '=', 'pending')
      .execute()
    const next = { ...entry, verification_generation: entry.verification_generation + 1 }
    await db
      .updateTable('waitlist_entries')
      .set({ verification_generation: next.verification_generation })
      .where('id', '=', entry.id)
      .execute()
    await generation(db, ctx, next, budget, et.id, now)
    return accepted()
  })
}

export async function verifyWaitlist(
  ctx: WaitlistContext,
  input: { token: string },
): Promise<{ verified: true }> {
  if (!validTokenShape(input.token)) throw invalidToken()
  return ctx.db.transaction().execute(async (db) => {
    await ensureWaitlistKey(
      db,
      ctx.secret,
      ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined,
    )
    const capability = await db
      .selectFrom('waitlist_capabilities')
      .selectAll()
      .where('token_hash', '=', waitlistTokenHash(input.token, 'verification'))
      .where('purpose', '=', 'verification')
      .executeTakeFirst()
    if (!capability) throw invalidToken()
    const initial = await db
      .selectFrom('waitlist_entries')
      .selectAll()
      .where('id', '=', capability.entry_id)
      .executeTakeFirst()
    if (!initial) throw invalidToken()
    await db
      .selectFrom('event_types')
      .select('id')
      .where('id', '=', initial.event_type_id)
      .forUpdate()
      .executeTakeFirst()
    const now = await waitlistNow(db, ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined)
    await expireEventEntries(db, initial.event_type_id, now)
    const entry = await db
      .selectFrom('waitlist_entries')
      .selectAll()
      .where('id', '=', initial.id)
      .forUpdate()
      .executeTakeFirstOrThrow()
    const current = await db
      .selectFrom('waitlist_capabilities')
      .selectAll()
      .where('id', '=', capability.id)
      .executeTakeFirst()
    if (
      !current ||
      current.revoked_at ||
      current.expires_at <= now ||
      entry.expires_at <= now ||
      entry.verification_generation !== current.generation ||
      !LIVE.includes(entry.status) ||
      !(await resolveWaitlistEventById(db, entry.event_type_id))
    )
      throw invalidToken()
    if (current.consumed_at) {
      if (entry.verified_at) return { verified: true }
      throw invalidToken()
    }
    if (entry.status !== 'pending_verification' || entry.pending_expires_at <= now)
      throw invalidToken()
    await db
      .updateTable('waitlist_entries')
      .set({ status: 'active', verified_at: now })
      .where('id', '=', entry.id)
      .execute()
    await db
      .updateTable('waitlist_capabilities')
      .set({ consumed_at: now })
      .where('id', '=', current.id)
      .execute()
    await db
      .updateTable('waitlist_verification_outbox')
      .set({ state: 'superseded', encrypted_payload: null, updated_at: now })
      .where('entry_id', '=', entry.id)
      .where('state', '=', 'pending')
      .execute()
    return { verified: true }
  })
}

/** Mint only for a concrete sender immediately before delivery, never for join responses. */
export async function mintWaitlistManagementToken(
  db: Db,
  entryId: string,
  now: Date,
): Promise<string> {
  if (!db.isTransaction) throw new Error('Waitlist capability creation needs a transaction')
  const entry = await db
    .selectFrom('waitlist_entries')
    .selectAll()
    .where('id', '=', entryId)
    .executeTakeFirst()
  if (
    !entry ||
    !LIVE.includes(entry.status) ||
    entry.expires_at <= now ||
    (entry.status === 'pending_verification' && entry.pending_expires_at <= now)
  )
    throw invalidToken()
  const token = tokenValue(entry.id)
  await db
    .insertInto('waitlist_capabilities')
    .values({
      entry_id: entry.id,
      purpose: 'management',
      token_hash: waitlistTokenHash(token, 'management'),
      generation: entry.verification_generation,
      expires_at: entry.expires_at,
      created_at: now,
    })
    .execute()
  return token
}

/** Later mail workers use this after their shared budget and lifecycle rechecks. */
export async function prepareWaitlistVerification(db: Db, ctx: WaitlistContext, outboxId: string) {
  if (!db.isTransaction) throw new Error('Waitlist verification preparation needs a transaction')
  await ensureWaitlistKey(
    db,
    ctx.secret,
    ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined,
  )
  const now = await waitlistNow(db, ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined)
  const row = await db
    .selectFrom('waitlist_verification_outbox')
    .selectAll()
    .where('id', '=', outboxId)
    .executeTakeFirst()
  if (row?.state !== 'pending' || row.expires_at <= now) return undefined
  const entry = await db
    .selectFrom('waitlist_entries')
    .selectAll()
    .where('id', '=', row.entry_id)
    .executeTakeFirst()
  if (
    entry?.status !== 'pending_verification' ||
    entry.verification_generation !== row.generation ||
    entry.pending_expires_at <= now ||
    entry.expires_at <= now ||
    !(await resolveWaitlistEventById(db, entry.event_type_id))
  )
    return undefined
  const payload = openWaitlistVerificationOutbox(ctx, row)
  if (!payload) return undefined
  const cap = await db
    .selectFrom('waitlist_capabilities')
    .selectAll()
    .where('token_hash', '=', waitlistTokenHash(payload.verificationToken, 'verification'))
    .executeTakeFirst()
  if (!cap || cap.revoked_at || cap.consumed_at || cap.expires_at <= now) return undefined
  const managementToken = await mintWaitlistManagementToken(db, entry.id, now)
  return {
    ...payload,
    managementToken,
    email: entry.email,
    name: entry.name,
    locale: entry.locale,
    expiresAt: entry.expires_at,
  }
}

export async function getWaitlistEntry(ctx: WaitlistContext, input: { token: string }) {
  if (!validTokenShape(input.token)) throw invalidToken()
  return ctx.db.transaction().execute(async (db) => {
    await ensureWaitlistKey(
      db,
      ctx.secret,
      ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined,
    )
    const now = await waitlistNow(db, ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined)
    const cap = await db
      .selectFrom('waitlist_capabilities')
      .selectAll()
      .where('token_hash', '=', waitlistTokenHash(input.token, 'management'))
      .where('purpose', '=', 'management')
      .executeTakeFirst()
    if (!cap || cap.revoked_at || cap.expires_at <= now) throw invalidToken()
    const entry = await db
      .selectFrom('waitlist_entries')
      .selectAll()
      .where('id', '=', cap.entry_id)
      .executeTakeFirst()
    if (
      !entry ||
      !LIVE.includes(entry.status) ||
      entry.expires_at <= now ||
      (entry.status === 'pending_verification' && entry.pending_expires_at <= now) ||
      !(await resolveWaitlistEventById(db, entry.event_type_id))
    )
      throw invalidToken()
    return {
      status: entry.status,
      email: entry.email,
      name: entry.name,
      expiresAt: entry.expires_at.toISOString(),
      preferredWindow: {
        start: entry.window_start?.toISOString(),
        end: entry.window_end?.toISOString(),
        timeZone: entry.time_zone,
      },
      locale: entry.locale,
    }
  })
}

export async function removeWaitlist(
  ctx: WaitlistContext,
  input: { token: string },
): Promise<{ removed: true }> {
  if (!validTokenShape(input.token)) throw invalidToken()
  return ctx.db.transaction().execute(async (db) => {
    await ensureWaitlistKey(
      db,
      ctx.secret,
      ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined,
    )
    const cap = await db
      .selectFrom('waitlist_capabilities')
      .selectAll()
      .where('token_hash', '=', waitlistTokenHash(input.token, 'management'))
      .where('purpose', '=', 'management')
      .executeTakeFirst()
    if (!cap) throw invalidToken()
    const entry = await db
      .selectFrom('waitlist_entries')
      .selectAll()
      .where('id', '=', cap.entry_id)
      .forUpdate()
      .executeTakeFirst()
    const now = await waitlistNow(db, ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined)
    if (!entry) throw invalidToken()
    if (entry.terminal_at) {
      if (now.getTime() - entry.terminal_at.getTime() >= 7 * DAY) throw invalidToken()
      await db
        .updateTable('waitlist_entries')
        .set({
          email: null,
          name: null,
          window_start: null,
          window_end: null,
          time_zone: null,
          locale: null,
        })
        .where('id', '=', entry.id)
        .execute()
      return { removed: true }
    }
    if (
      cap.revoked_at ||
      cap.expires_at <= now ||
      entry.expires_at <= now ||
      (entry.status === 'pending_verification' && entry.pending_expires_at <= now)
    )
      throw invalidToken()
    await db
      .updateTable('waitlist_entries')
      .set({ status: 'removed', terminal_at: now, terminal_reason: 'self_removed' })
      .where('id', '=', entry.id)
      .execute()
    return { removed: true }
  })
}

/** Hourly, bounded recovery. Contact deletion happens on the first pass, never after 24h. */
export async function cleanupWaitlist(ctx: WaitlistContext, options: { limit?: number } = {}) {
  const limit = Math.max(1, Math.min(1000, options.limit ?? 100))
  return ctx.db.transaction().execute(async (db) => {
    await ensureWaitlistKey(
      db,
      ctx.secret,
      ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined,
    )
    const now = await waitlistNow(db, ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined)
    const due = await db
      .selectFrom('waitlist_entries')
      .select('id')
      .where('status', 'in', LIVE)
      .where((eb) =>
        eb.or([
          eb('expires_at', '<=', now),
          eb.and([eb('status', '=', 'pending_verification'), eb('pending_expires_at', '<=', now)]),
        ]),
      )
      .orderBy('expires_at')
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute()
    if (due.length)
      await db
        .updateTable('waitlist_entries')
        .set({ status: 'expired', terminal_at: now, terminal_reason: 'deadline_reached' })
        .where(
          'id',
          'in',
          due.map((row) => row.id),
        )
        .execute()
    const terminal = await db
      .selectFrom('waitlist_entries')
      .select('id')
      .where('status', 'in', ['booked', 'expired', 'removed'])
      .where('email', 'is not', null)
      .orderBy('terminal_at')
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute()
    if (terminal.length)
      await db
        .updateTable('waitlist_entries')
        .set({
          email: null,
          name: null,
          window_start: null,
          window_end: null,
          time_zone: null,
          locale: null,
        })
        .where(
          'id',
          'in',
          terminal.map((row) => row.id),
        )
        .execute()
    const old = await db
      .selectFrom('waitlist_entries')
      .select('id')
      .where('terminal_at', '<=', new Date(now.getTime() - 7 * DAY))
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute()
    if (old.length)
      await db
        .deleteFrom('waitlist_entries')
        .where(
          'id',
          'in',
          old.map((row) => row.id),
        )
        .execute()
    const requests = await db
      .selectFrom('waitlist_verification_requests')
      .select('id')
      .where('requested_at', '<=', new Date(now.getTime() - 2 * DAY))
      .limit(limit)
      .execute()
    if (requests.length)
      await db
        .deleteFrom('waitlist_verification_requests')
        .where(
          'id',
          'in',
          requests.map((row) => row.id),
        )
        .execute()
    const outbox = await db
      .selectFrom('waitlist_verification_outbox')
      .select('id')
      .where('expires_at', '<=', now)
      .where('encrypted_payload', 'is not', null)
      .limit(limit)
      .execute()
    if (outbox.length)
      await db
        .updateTable('waitlist_verification_outbox')
        .set({ state: 'expired', encrypted_payload: null, updated_at: now })
        .where(
          'id',
          'in',
          outbox.map((row) => row.id),
        )
        .execute()
    const candidates = await db
      .selectFrom('waitlist_candidates')
      .select('id')
      .where('expires_at', '<=', now)
      .where('state', 'in', ['pending', 'processing'])
      .limit(limit)
      .execute()
    if (candidates.length)
      await db
        .updateTable('waitlist_candidates')
        .set({ state: 'expired', claim_token: null, lease_until: null, updated_at: now })
        .where(
          'id',
          'in',
          candidates.map((row) => row.id),
        )
        .execute()
    const oldCandidates = await db
      .selectFrom('waitlist_candidates')
      .select('id')
      .where('state', 'not in', ['pending', 'processing'])
      .where('expires_at', '<=', new Date(now.getTime() - 7 * DAY))
      .limit(limit)
      .execute()
    if (oldCandidates.length)
      await db
        .deleteFrom('waitlist_candidates')
        .where(
          'id',
          'in',
          oldCandidates.map((row) => row.id),
        )
        .execute()
    const caps = await db
      .selectFrom('waitlist_capabilities as c')
      .innerJoin('waitlist_entries as e', 'e.id', 'c.entry_id')
      .select('c.id')
      .where('c.expires_at', '<=', now)
      .where('e.terminal_at', 'is', null)
      .limit(limit)
      .execute()
    if (caps.length)
      await db
        .deleteFrom('waitlist_capabilities')
        .where(
          'id',
          'in',
          caps.map((row) => row.id),
        )
        .execute()
    // Exact UTC keys have independent retention, with no entry/event cascading authority.
    const tombstones =
      await sql`DELETE FROM waitlist_slot_tombstones WHERE (event_type_id,recipient_hash,start_at,end_at) IN (SELECT event_type_id,recipient_hash,start_at,end_at FROM waitlist_slot_tombstones WHERE purge_at <= ${now} ORDER BY purge_at LIMIT ${limit}) RETURNING event_type_id`.execute(
        db,
      )
    const observations =
      await sql`DELETE FROM waitlist_slots WHERE (event_type_id,start_at,end_at) IN (SELECT event_type_id,start_at,end_at FROM waitlist_slots WHERE end_at <= ${now} ORDER BY end_at LIMIT ${limit}) RETURNING event_type_id`.execute(
        db,
      )
    const cohorts = await db
      .selectFrom('waitlist_cohorts as c')
      .select('c.id')
      .where('c.discovered_at', '<=', new Date(now.getTime() - 7 * DAY))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('waitlist_candidates as n')
              .select('n.id')
              .whereRef('n.cohort_id', '=', 'c.id'),
          ),
        ),
      )
      .limit(limit)
      .execute()
    if (cohorts.length)
      await db
        .deleteFrom('waitlist_cohorts')
        .where(
          'id',
          'in',
          cohorts.map((row) => row.id),
        )
        .execute()
    return {
      expired: due.length,
      erased: terminal.length,
      deleted: old.length,
      requests: requests.length,
      more: [
        due.length,
        terminal.length,
        old.length,
        requests.length,
        outbox.length,
        candidates.length,
        oldCandidates.length,
        caps.length,
        cohorts.length,
        tombstones.rows.length,
        observations.rows.length,
      ].some((count) => count >= limit),
    }
  })
}
