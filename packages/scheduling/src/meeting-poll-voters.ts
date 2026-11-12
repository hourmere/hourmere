// Voter admission for meeting polls: public enrollment, mailbox verification and lost-mail
// recovery, plus host invitations and invitation resends. Internal services only: no
// transport, worker or mail sender (docs/meeting-polls.md). Mail is a durable delivery row
// carrying the credential encrypted; later delivery workers send it.
//
// Every write serializes on the poll row. Host writes keep the lifecycle order: the
// organization-write hook, actor user, organization and membership SHARE, the poll FOR
// UPDATE, then its event FOR SHARE. Public writes take public booking's organization order
// (a personal owner's user SHARE, then the organization SHARE), then the same poll FOR
// UPDATE and event FOR SHARE. Neither takes host booking locks. The database clock is read
// once after those locks and decides capacity, expiry, deadline and cooldowns.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto'
import { interfaceLanguage } from '@hourmere/core/language'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { lockOrganization } from './hosts.ts'
import { isUuid, validTimeZone } from './internal.ts'
import { MEETING_POLL_LIMITS } from './meeting-poll-policy.ts'
import {
  alreadyScheduled,
  changed,
  insertReceipt,
  keyReused,
  type LockedPoll,
  loadPoll,
  lockedReceipt,
  lockManagedPoll,
  type MeetingPoll,
  type MeetingPollHostWriteInput,
  meetingPollPublicTokenDigest,
  pollNotFound,
  receiptIdentity,
  requireHostRevision,
  requireWriteScope,
  validHostWrite,
  validIdempotencyKey,
} from './meeting-polls.ts'
import { cleanInviteeEmail, cleanText } from './text.ts'
import { waitlistIpBucket } from './waitlist.ts'

/** Public voter operations: the installation secret and the transport's trusted client IP. */
export interface MeetingPollPublicContext {
  db: Db
  /** Keys mailbox and IP digests and encrypts retained credentials; never sent to clients. */
  meetingPollSecret: string
  /** Resolved by the trusted transport, never copied from request headers or input. */
  trustedIp?: string | undefined
}

/** Host roster operations: an authenticated manager plus the installation secret. */
export interface MeetingPollHostContext extends ServiceContext {
  meetingPollSecret: string
}

export interface EnrollMeetingPollVoterInput {
  publicToken: string
  name: string
  email: string
  timeZone: string
  locale?: string | undefined
}

export interface MeetingPollInvitee {
  name: string
  email: string
  /** The invitation language; the instance fallback (English) when omitted. */
  locale?: string | undefined
  /** Defaults to the poll's display time zone. */
  timeZone?: string | undefined
}

export interface InviteMeetingPollVotersInput {
  id: string
  invitees: MeetingPollInvitee[]
  idempotencyKey: string
}

export interface ResendMeetingPollInvitationInput extends MeetingPollHostWriteInput {
  voterId: string
  idempotencyKey: string
}

/** A voter's own state. Never another voter's data and never a digest. */
export interface MeetingPollVoterState {
  pollId: string
  voterId: string
  name: string
  email: string
  timeZone: string
  locale: string
  status: 'pending' | 'invited' | 'verified' | 'withdrawn'
  deadlineAt: string
}

export interface VerifyMeetingPollVoterResult {
  voter: MeetingPollVoterState
  /**
   * The voting credential minted when a public enrollee verifies. It is also mailed; the
   * response carries it this once. Null for invitees, whose emailed credential already
   * votes, and for every repeat.
   */
  votingToken: string | null
}

/** What this request did for one mailbox; `status` is its current roster state. */
export type MeetingPollInvitationOutcome = 'invited' | 'upgraded' | 'unchanged'
export type MeetingPollRosterStatus = 'pending' | 'invited' | 'verified' | 'withdrawn' | 'absent'

export interface MeetingPollInvitationEntry {
  email: string
  outcome: MeetingPollInvitationOutcome
  voterId: string | null
  status: MeetingPollRosterStatus
}

/** Host result. It never contains a voter credential. */
export interface MeetingPollInvitationResult {
  poll: MeetingPoll
  replayed: boolean
  entries: MeetingPollInvitationEntry[]
}

export interface MeetingPollResendResult {
  poll: MeetingPoll
  voterId: string
  replayed: boolean
}

/** 429 `rate_limited`; `retryAfterSeconds` is set when a later retry can succeed. */
export class MeetingPollRateLimitError extends Error {
  readonly code = 'rate_limited'
  readonly retryAfterSeconds: number | undefined

  constructor(retryAfterSeconds?: number) {
    super('rate_limited')
    this.name = 'MeetingPollRateLimitError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

type CredentialPurpose = 'verification' | 'voting'
type CredentialMailKind = 'verification' | 'invitation' | 'recovery'

const TOKEN = /^[A-Za-z0-9_-]{43}$/
const MAX_NAME = 200
const INVITEE_FIELDS = new Set(['name', 'email', 'locale', 'timeZone'])
/** Deliveries that carry an emailed verification or voting credential. */
const CREDENTIAL_MAIL: readonly CredentialMailKind[] = ['verification', 'invitation', 'recovery']
const UTC_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'

const pollFull = () =>
  new DomainError('conflict', 'poll_full', 'This poll has no free places for new voters.')
const pollClosed = () => new DomainError('conflict', 'poll_closed', 'Voting on this poll is closed')
const pollCanceled = () => new DomainError('conflict', 'poll_canceled', 'This poll was canceled')
const invalidVoter = (message: string) => new DomainError('invalid', 'invalid_voter', message)
const voterWithdrawn = () =>
  new DomainError(
    'conflict',
    'voter_withdrawn',
    'This voter withdrew and opted out of poll mail. Only their own link can rejoin.',
  )
const accepted = () => ({ accepted: true as const })

// --- Digests and retained credentials ------------------------------------------------------

const derivedKey = (secret: string, purpose: string) =>
  Buffer.from(hkdfSync('sha256', secret, 'hourmere/meeting-poll', purpose, 32))

/** Keyed digest of a normalized mailbox, separate per poll. */
export function meetingPollMailboxKey(secret: string, pollId: string, email: string): Buffer {
  return createHmac('sha256', derivedKey(secret, 'mailbox/v1'))
    .update(`${pollId.toLowerCase()}\0${email}`)
    .digest()
}

/** Keyed digest of the trusted client IP (IPv6 by /64), separate per poll. */
function admissionIpDigest(secret: string, pollId: string, ip: string | undefined): Buffer {
  return createHmac('sha256', derivedKey(secret, 'admission-ip/v1'))
    .update(`${pollId.toLowerCase()}\0${waitlistIpBucket(ip)}`)
    .digest()
}

/** Stored digest of a voter credential; the purpose is part of the digest. */
export function meetingPollCapabilityDigest(purpose: CredentialPurpose, token: string): Buffer {
  return createHash('sha256')
    .update(`hourmere.meeting-poll.capability.${purpose}\0${token}`, 'utf8')
    .digest()
}

/** One emailed credential: a voter's verification and voting credentials share one line. */
export interface MeetingPollCredentialBinding {
  organizationId: string
  pollId: string
  voterId: string
  generation: number
}

const credentialAad = (binding: MeetingPollCredentialBinding) =>
  Buffer.from(
    `hourmere:meeting-poll-capability:v1:${binding.organizationId}:${binding.pollId}:${binding.voterId}:${binding.generation}`,
  )

function sealCredential(
  secret: string,
  binding: MeetingPollCredentialBinding,
  purpose: CredentialPurpose,
  token: string,
): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', derivedKey(secret, 'capability/v1'), iv)
  cipher.setAAD(credentialAad(binding))
  const body = Buffer.concat([
    cipher.update(JSON.stringify({ purpose, token }), 'utf8'),
    cipher.final(),
  ])
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body])
}

/**
 * Decrypt a retained or queued credential for the delivery workers. The ciphertext is
 * authenticated to its organization, poll, voter and generation; anything else is refused.
 */
export function openMeetingPollCredential(
  secret: string,
  binding: MeetingPollCredentialBinding,
  ciphertext: Buffer | null,
): { purpose: CredentialPurpose; token: string } | undefined {
  try {
    if (!ciphertext || ciphertext.length < 30 || ciphertext.length > 1024 || ciphertext[0] !== 1)
      return undefined
    const decipher = createDecipheriv(
      'aes-256-gcm',
      derivedKey(secret, 'capability/v1'),
      ciphertext.subarray(1, 13),
    )
    decipher.setAAD(credentialAad(binding))
    decipher.setAuthTag(ciphertext.subarray(13, 29))
    const parsed: unknown = JSON.parse(
      Buffer.concat([decipher.update(ciphertext.subarray(29)), decipher.final()]).toString('utf8'),
    )
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { purpose, token } = parsed as { purpose?: unknown; token?: unknown }
    if ((purpose !== 'verification' && purpose !== 'voting') || typeof token !== 'string')
      return undefined
    if (!TOKEN.test(token)) return undefined
    return { purpose, token }
  } catch {
    return undefined
  }
}

// --- Public enrollment, verification and recovery -------------------------------------------

/**
 * Join a public-link poll. The answer is the same whether the mailbox is new, pending,
 * verified, withdrawn or removed: 202 without a credential, mailing a verification link only
 * to a new mailbox (or one whose public reservation expired). When the poll is full every
 * request gets 409 `poll_full`, and three live reservations from one IP get 429, both
 * decided before the mailbox is looked at.
 */
export async function enrollMeetingPollVoter(
  ctx: MeetingPollPublicContext,
  input: EnrollMeetingPollVoterInput,
): Promise<{ accepted: true }> {
  const secret = requireSecret(ctx.meetingPollSecret)
  if (!input || typeof input !== 'object') throw invalidVoter('The request must be an object')
  const publicToken = validToken(input.publicToken)
  const voter = validPerson(input)
  const timeZone = validTimeZone(input.timeZone)
  const locale = validLocale(input.locale)
  const digest = meetingPollPublicTokenDigest(publicToken)
  return ctx.db.transaction().execute(async (trx) => {
    const named = await trx
      .selectFrom('meeting_polls')
      .select(['id', 'organization_id'])
      .where('public_token_digest', '=', digest)
      .executeTakeFirst()
    if (!named) throw pollNotFound()
    // A link rotated while this request waited no longer admits anyone.
    const poll = await lockPublicPoll(trx, named, digest)
    if (!poll) throw pollNotFound()
    requireVotingOpen(poll, pollClosed)
    const ipDigest = admissionIpDigest(secret, poll.id, ctx.trustedIp)
    const counts = await admissionCounts(trx, poll.id, poll.at, ipDigest)
    if (counts.active >= MEETING_POLL_LIMITS.maxEnrollments) throw pollFull()
    if (counts.fromIp >= MEETING_POLL_LIMITS.maxPendingPerIp)
      throw new MeetingPollRateLimitError(counts.ipRetryAfter ?? undefined)
    const emailKey = meetingPollMailboxKey(secret, poll.id, voter.email)
    const [existing] = await votersByMailbox(trx, poll, [emailKey])
    const counter = await trx
      .selectFrom('meeting_poll_mailbox_counters')
      .select('removed_at')
      .where('poll_id', '=', poll.id)
      .where('email_key', '=', emailKey)
      .executeTakeFirst()
    // Known, pending, verified, withdrawn and removed mailboxes all get the same answer.
    if (counter?.removed_at || (existing && !existing.expired)) return accepted()
    if (existing) await deleteVoter(trx, poll, existing.id)
    const pendingExpiresAt = earlier(
      Temporal.Instant.from(poll.at)
        .add({ seconds: MEETING_POLL_LIMITS.pendingExpirySeconds })
        .toString(),
      poll.deadline,
    )
    const row = await trx
      .insertInto('meeting_poll_voters')
      .values({
        organization_id: poll.organizationId,
        poll_id: poll.id,
        name: voter.name,
        email: voter.email,
        email_key: emailKey,
        pending_expires_at: pendingExpiresAt,
        admission_ip_digest: ipDigest,
        time_zone: timeZone,
        locale,
        created_at: poll.at,
        updated_at: poll.at,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const credential = await issueCredential(
      trx,
      poll,
      row.id,
      'verification',
      pendingExpiresAt,
      secret,
    )
    await queueCredentialMail(trx, poll, row.id, 'verification', credential, 'first')
    await newCurrentCredential(trx, poll, emailKey, { clearRemoval: false })
    await advanceRevisions(trx, poll, { host: false })
    return accepted()
  })
}

/**
 * Confirm mailbox possession with an emailed credential, by explicit request only. A public
 * enrollee's verification credential is consumed and replaced by a voting credential, which
 * is mailed and also returned once; an invitee's voting credential stays the same and
 * nothing is mailed. Repeats return the current state without minting or mailing anything.
 * Expired or revoked credentials never verify.
 */
export async function verifyMeetingPollVoter(
  ctx: MeetingPollPublicContext,
  input: { token: string },
): Promise<VerifyMeetingPollVoterResult> {
  const secret = requireSecret(ctx.meetingPollSecret)
  const token = validToken(input?.token)
  const verification = meetingPollCapabilityDigest('verification', token)
  const voting = meetingPollCapabilityDigest('voting', token)
  return ctx.db.transaction().execute(async (trx) => {
    const named = await trx
      .selectFrom('meeting_poll_capabilities')
      .select(['id', 'poll_id', 'organization_id'])
      .where((eb) =>
        eb.or([
          eb.and([eb('purpose', '=', 'verification'), eb('token_digest', '=', verification)]),
          eb.and([eb('purpose', '=', 'voting'), eb('token_digest', '=', voting)]),
        ]),
      )
      .executeTakeFirst()
    if (!named) throw pollNotFound()
    const poll = await lockPublicPoll(trx, {
      id: named.poll_id,
      organization_id: named.organization_id,
    })
    if (!poll) throw pollNotFound()
    const credential = await trx
      .selectFrom('meeting_poll_capabilities as c')
      .innerJoin('meeting_poll_voters as v', (join) =>
        join.onRef('v.id', '=', 'c.voter_id').onRef('v.poll_id', '=', 'c.poll_id'),
      )
      .select([
        'c.purpose',
        'c.voter_id',
        sql<boolean>`c.revoked_at IS NOT NULL`.as('revoked'),
        sql<boolean>`c.consumed_at IS NOT NULL`.as('consumed'),
        sql<boolean>`c.expires_at > ${poll.at}::timestamptz`.as('live'),
        sql<boolean>`v.verified_at IS NOT NULL`.as('verified'),
        sql<boolean>`v.withdrawn_at IS NOT NULL`.as('withdrawn'),
        'v.email_key',
      ])
      .where('c.id', '=', named.id)
      .where('c.poll_id', '=', poll.id)
      .executeTakeFirst()
    if (!credential || credential.revoked) throw pollNotFound()
    // An expired verification credential is invalid, whatever the poll's state.
    if (credential.purpose === 'verification' && !credential.live) throw pollNotFound()
    requireVotingOpen(poll, pollClosed)
    const voterId = credential.voter_id
    if (credential.purpose === 'verification') {
      // Consumed by this voter's verification: a repeat returns the state and mints nothing.
      // A live unconsumed one belongs to a live reservation (its expiry bounds the credential).
      if (credential.consumed)
        return { voter: await voterState(trx, poll, voterId), votingToken: null }
      await trx
        .updateTable('meeting_poll_voters')
        .set({
          verified_at: poll.at,
          pending_expires_at: null,
          admission_ip_digest: null,
          updated_at: poll.at,
        })
        .where('id', '=', voterId)
        .where('poll_id', '=', poll.id)
        .execute()
      await retireCredentials(trx, poll, voterId, 'verification', 'consumed')
      const votingCredential = await issueCredential(
        trx,
        poll,
        voterId,
        'voting',
        poll.deadline,
        secret,
      )
      // The mailbox gets the new voting credential as a verification delivery at that
      // credential's generation (one generation line, so the delivery identity is unique);
      // delivery applies the same mail budgets as every poll mail. A newly mailed credential
      // restarts the mailbox's recovery count.
      await queueCredentialMail(trx, poll, voterId, 'verification', votingCredential, 'first')
      await newCurrentCredential(trx, poll, credential.email_key, { clearRemoval: false })
      await advanceRevisions(trx, poll, { host: false })
      return { voter: await voterState(trx, poll, voterId), votingToken: votingCredential.token }
    }
    if (!credential.verified && !credential.withdrawn) {
      await trx
        .updateTable('meeting_poll_voters')
        .set({ verified_at: poll.at, updated_at: poll.at })
        .where('id', '=', voterId)
        .where('poll_id', '=', poll.id)
        .execute()
      await advanceRevisions(trx, poll, { host: false })
    }
    return { voter: await voterState(trx, poll, voterId), votingToken: null }
  })
}

/**
 * Lost-mail recovery by poll ID and mailbox, in either admission mode. Always 202. It queues
 * the voter's current credential again, unchanged, for an eligible voter only: the
 * verification credential of a live public reservation, or the voting credential of a
 * verified voter or an invitee. It never mints, rotates or revokes a credential and never
 * extends a reservation; one delivery per mailbox per 15 minutes and three per credential.
 */
export async function recoverMeetingPollVoter(
  ctx: MeetingPollPublicContext,
  input: { pollId: string; email: string },
): Promise<{ accepted: true }> {
  const secret = requireSecret(ctx.meetingPollSecret)
  if (!input || typeof input !== 'object') throw invalidVoter('The request must be an object')
  const email = validEmail(input.email)
  if (!isUuid(input.pollId)) return accepted()
  const pollId = input.pollId
  await ctx.db.transaction().execute(async (trx) => {
    const named = await trx
      .selectFrom('meeting_polls')
      .select(['id', 'organization_id'])
      .where('id', '=', pollId)
      .executeTakeFirst()
    if (!named) return
    const poll = await lockPublicPoll(trx, named)
    if (!poll || !votingOpenOrClosedEarly(poll)) return
    const emailKey = meetingPollMailboxKey(secret, poll.id, email)
    const [voter] = await votersByMailbox(trx, poll, [emailKey])
    if (!voter || voter.status === 'withdrawn' || voter.expired) return
    const purpose: CredentialPurpose = voter.status === 'pending' ? 'verification' : 'voting'
    const credential = await trx
      .selectFrom('meeting_poll_capabilities')
      .select(['generation', 'capability_ciphertext'])
      .where('poll_id', '=', poll.id)
      .where('voter_id', '=', voter.id)
      .where('purpose', '=', purpose)
      .where('revoked_at', 'is', null)
      .where('consumed_at', 'is', null)
      .where('capability_ciphertext', 'is not', null)
      .where(sql<boolean>`expires_at > ${poll.at}::timestamptz`)
      .orderBy('generation', 'desc')
      .executeTakeFirst()
    if (!credential?.capability_ciphertext) return
    const counter = await ensureCounter(trx, poll, emailKey)
    if (
      counter.recovery_count >= MEETING_POLL_LIMITS.maxRecoveriesPerCredential ||
      counter.recoveryCooling
    )
      return
    await queueCredentialMail(
      trx,
      poll,
      voter.id,
      'recovery',
      { generation: credential.generation, ciphertext: credential.capability_ciphertext },
      'next',
    )
    await trx
      .updateTable('meeting_poll_mailbox_counters')
      .set({
        recovery_count: counter.recovery_count + 1,
        last_recovery_at: poll.at,
        updated_at: poll.at,
      })
      .where('poll_id', '=', poll.id)
      .where('email_key', '=', emailKey)
      .execute()
  })
  return accepted()
}

// --- Host invitations and resends ------------------------------------------------------------

/**
 * Invite up to 40 mailboxes while voting is open. Each mailbox the poll already knows is
 * resolved first: active invitees, verified voters and withdrawn voters are unchanged; a
 * live public reservation becomes an invitation in its place; an expired reservation or a
 * removed mailbox is invited as new. If the new places exceed the free ones, the whole
 * batch is refused with 409 `poll_full` and nothing is written or mailed. An exact replay
 * mails nothing and reports each mailbox's current roster state.
 */
export async function inviteMeetingPollVoters(
  ctx: MeetingPollHostContext,
  input: InviteMeetingPollVotersInput,
): Promise<MeetingPollInvitationResult> {
  requireWriteScope(ctx)
  const secret = requireSecret(ctx.meetingPollSecret)
  const request = validInvitation(input)
  return ctx.db.transaction().execute(async (trx) => {
    const locked = await lockManagedPoll(trx, ctx, request.id)
    const poll = hostPoll(locked)
    const receipt = receiptIdentity(ctx, 'invite', request.idempotencyKey, {
      pollId: poll.id.toLowerCase(),
      invitees: request.invitees,
    })
    const previous = await lockedReceipt(trx, receipt)
    const keys = request.invitees.map((invitee) =>
      meetingPollMailboxKey(secret, poll.id, invitee.email),
    )
    if (previous) {
      if (!previous.request_fingerprint.equals(receipt.fingerprint)) throw keyReused()
      const current = await votersByMailbox(trx, poll, keys)
      return {
        poll: await loadPoll(trx, ctx, poll.id),
        replayed: true,
        entries: request.invitees.map((invitee, index) => {
          const voter = current.find((row) => row.email_key.equals(keys[index] as Buffer))
          return {
            email: invitee.email,
            outcome: 'unchanged' as const,
            voterId: voter && !voter.expired ? voter.id : null,
            status: voter && !voter.expired ? voter.status : ('absent' as const),
          }
        }),
      }
    }
    requireHostVotingOpen(locked)
    const known = await votersByMailbox(trx, poll, keys)
    const plan = request.invitees.map((invitee, index) => {
      const key = keys[index] as Buffer
      const voter = known.find((row) => row.email_key.equals(key))
      const outcome: MeetingPollInvitationOutcome =
        !voter || voter.expired ? 'invited' : voter.status === 'pending' ? 'upgraded' : 'unchanged'
      return { invitee, key, voter, outcome }
    })
    const added = plan.filter((entry) => entry.outcome === 'invited').length
    if (added > 0) {
      const { active } = await admissionCounts(trx, poll.id, poll.at)
      // All or nothing: no prefix of a batch that does not fit is admitted.
      if (active + added > MEETING_POLL_LIMITS.maxEnrollments) throw pollFull()
    }
    const entries: MeetingPollInvitationEntry[] = []
    for (const { invitee, key, voter, outcome } of plan) {
      if (outcome === 'unchanged' && voter) {
        entries.push({ email: invitee.email, outcome, voterId: voter.id, status: voter.status })
        continue
      }
      let voterId: string
      if (outcome === 'upgraded' && voter) {
        voterId = voter.id
        await trx
          .updateTable('meeting_poll_voters')
          .set({
            invited_at: poll.at,
            pending_expires_at: null,
            admission_ip_digest: null,
            updated_at: poll.at,
          })
          .where('id', '=', voter.id)
          .where('poll_id', '=', poll.id)
          .execute()
        await retireCredentials(trx, poll, voter.id, 'verification', 'revoked')
      } else {
        if (voter) await deleteVoter(trx, poll, voter.id)
        const row = await trx
          .insertInto('meeting_poll_voters')
          .values({
            organization_id: poll.organizationId,
            poll_id: poll.id,
            name: invitee.name,
            email: invitee.email,
            email_key: key,
            invited_at: poll.at,
            time_zone: invitee.timeZone ?? locked.display_time_zone,
            locale: invitee.locale ?? 'en',
            created_at: poll.at,
            updated_at: poll.at,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        voterId = row.id
      }
      const credential = await issueCredential(trx, poll, voterId, 'voting', poll.deadline, secret)
      await queueCredentialMail(trx, poll, voterId, 'invitation', credential, 'first')
      // A host's explicit invitation also clears a removal tombstone.
      await newCurrentCredential(trx, poll, key, { clearRemoval: true })
      entries.push({
        email: invitee.email,
        outcome,
        voterId,
        status: 'invited',
      })
    }
    if (entries.some((entry) => entry.outcome !== 'unchanged'))
      await advanceRevisions(trx, poll, { host: true, hostRevision: locked.host_revision })
    await insertReceipt(trx, receipt, poll.id, poll.at)
    return { poll: await loadPoll(trx, ctx, poll.id), replayed: false, entries }
  })
}

/**
 * Mail an invitee a new voting credential while voting is open; the previous one stops
 * working and its queued mail is skipped. No new place is taken. One accepted resend per
 * mailbox per 15 minutes and three per poll and mailbox, counted apart from recovery and
 * kept across removal and re-invitation. A matching retry is reported without mail.
 */
export async function resendMeetingPollInvitation(
  ctx: MeetingPollHostContext,
  input: ResendMeetingPollInvitationInput,
): Promise<MeetingPollResendResult> {
  requireWriteScope(ctx)
  const secret = requireSecret(ctx.meetingPollSecret)
  const request = validHostWrite(input)
  const key = validIdempotencyKey(input.idempotencyKey)
  const voterId = input.voterId
  return ctx.db.transaction().execute(async (trx) => {
    const locked = await lockManagedPoll(trx, ctx, request.id)
    const poll = hostPoll(locked)
    if (!isUuid(voterId)) throw pollNotFound()
    const receipt = receiptIdentity(ctx, 'resend', key, {
      pollId: poll.id.toLowerCase(),
      voterId: voterId.toLowerCase(),
      expectedHostRevision: request.expectedHostRevision,
    })
    // A lost successful response stays recoverable after the revision has advanced.
    const previous = await lockedReceipt(trx, receipt)
    if (previous) {
      if (!previous.request_fingerprint.equals(receipt.fingerprint)) throw keyReused()
      return { poll: await loadPoll(trx, ctx, poll.id), voterId, replayed: true }
    }
    requireHostVotingOpen(locked)
    requireHostRevision(locked, request.expectedHostRevision)
    const voter = await trx
      .selectFrom('meeting_poll_voters')
      .select(['id', 'email_key', 'invited_at', 'withdrawn_at'])
      .where('id', '=', voterId)
      .where('poll_id', '=', poll.id)
      .executeTakeFirst()
    if (!voter || voter.invited_at === null) throw pollNotFound()
    if (voter.withdrawn_at !== null) throw voterWithdrawn()
    const counter = await ensureCounter(trx, poll, voter.email_key)
    if (counter.resend_count >= MEETING_POLL_LIMITS.maxResendsPerMailbox)
      throw new MeetingPollRateLimitError()
    if (counter.resendRetryAfter !== null)
      throw new MeetingPollRateLimitError(counter.resendRetryAfter)
    await retireCredentials(trx, poll, voter.id, 'voting', 'revoked')
    const credential = await issueCredential(trx, poll, voter.id, 'voting', poll.deadline, secret)
    await queueCredentialMail(trx, poll, voter.id, 'invitation', credential, 'first')
    await trx
      .updateTable('meeting_poll_mailbox_counters')
      .set({
        resend_count: counter.resend_count + 1,
        last_resend_at: poll.at,
        // A new credential restarts the recovery allowance for it.
        recovery_count: 0,
        last_recovery_at: null,
        updated_at: poll.at,
      })
      .where('poll_id', '=', poll.id)
      .where('email_key', '=', voter.email_key)
      .execute()
    await advanceRevisions(trx, poll, {
      host: true,
      hostRevision: locked.host_revision,
      results: false,
    })
    await insertReceipt(trx, receipt, poll.id, poll.at)
    return { poll: await loadPoll(trx, ctx, poll.id), voterId: voter.id, replayed: false }
  })
}

// --- Locks and lifecycle ---------------------------------------------------------------------

interface VoterPoll {
  id: string
  organizationId: string
  status: string
  deadlinePassed: boolean
  eventDeleted: boolean
  deadline: string
  /** Database clock captured once after the poll and event locks. */
  at: string
}

function hostPoll(poll: LockedPoll): VoterPoll {
  return {
    id: poll.id,
    organizationId: poll.organization_id,
    status: poll.status,
    deadlinePassed: poll.status === 'open' && poll.effectiveStatus === 'closed',
    eventDeleted: poll.eventDeleted,
    deadline: poll.deadline,
    at: poll.at,
  }
}

/**
 * Public writes: public booking's organization locks, then the poll FOR UPDATE (matching
 * `publicTokenDigest` when given) and its event FOR SHARE, then one clock reading.
 */
async function lockPublicPoll(
  trx: Db,
  named: { id: string; organization_id: string },
  publicTokenDigest?: Buffer,
): Promise<VoterPoll | undefined> {
  try {
    await lockOrganization(trx, named.organization_id)
  } catch (error) {
    if (error instanceof DomainError) return undefined
    throw error
  }
  const poll = await trx
    .selectFrom('meeting_polls')
    .select(['id', 'organization_id', 'event_type_id', 'status'])
    .where('id', '=', named.id)
    .where('organization_id', '=', named.organization_id)
    .$if(publicTokenDigest !== undefined, (query) =>
      query.where('public_token_digest', '=', publicTokenDigest as Buffer),
    )
    .forUpdate()
    .executeTakeFirst()
  if (!poll) return undefined
  const event = await trx
    .selectFrom('event_types')
    .select('deleted_at')
    .where('id', '=', poll.event_type_id)
    .where('organization_id', '=', poll.organization_id)
    .forShare()
    .executeTakeFirst()
  const { rows } = await sql<{ at: string; deadline: string; deadlinePassed: boolean }>`
    WITH decision AS MATERIALIZED (SELECT clock_timestamp() AS t)
    SELECT to_char(decision.t AT TIME ZONE 'UTC', ${sql.lit(UTC_FORMAT)}) AS at,
      to_char(poll.deadline_at AT TIME ZONE 'UTC', ${sql.lit(UTC_FORMAT)}) AS deadline,
      poll.deadline_at <= decision.t AS "deadlinePassed"
    FROM meeting_polls AS poll CROSS JOIN decision
    WHERE poll.id = ${poll.id}`.execute(trx)
  const { at, deadline, deadlinePassed } = rows[0] as (typeof rows)[number]
  return {
    id: poll.id,
    organizationId: poll.organization_id,
    status: poll.status,
    deadlinePassed,
    eventDeleted: !event || event.deleted_at !== null,
    deadline,
    at,
  }
}

/** Voting, admission and verification need an open poll strictly before its deadline. */
function requireVotingOpen(poll: VoterPoll, scheduled: () => DomainError) {
  if (poll.status === 'canceled') throw pollCanceled()
  if (poll.status === 'scheduled') throw scheduled()
  if (poll.status !== 'open' || poll.deadlinePassed || poll.eventDeleted) throw pollClosed()
}

function requireHostVotingOpen(poll: LockedPoll) {
  requireVotingOpen(hostPoll(poll), alreadyScheduled)
}

/** Recovery delivers before the deadline while the poll is open or closed early. */
function votingOpenOrClosedEarly(poll: VoterPoll) {
  return (
    (poll.status === 'open' || poll.status === 'closed') &&
    !poll.deadlinePassed &&
    !poll.eventDeleted
  )
}

/**
 * Places in use at `at`: active verified voters, active invitations and live public
 * reservations, once each. Withdrawn voters and expired reservations never count.
 */
async function admissionCounts(trx: Db, pollId: string, at: string, ipDigest?: Buffer) {
  const { rows } = await sql<{ active: string; fromIp: string; ipRetryAfter: string | null }>`
    SELECT count(*) FILTER (WHERE withdrawn_at IS NULL AND (verified_at IS NOT NULL
        OR invited_at IS NOT NULL OR pending_expires_at > ${at}::timestamptz))::text AS active,
      count(*) FILTER (WHERE pending_expires_at > ${at}::timestamptz
        AND admission_ip_digest = ${ipDigest ?? null}::bytea)::text AS "fromIp",
      ceil(extract(epoch FROM min(pending_expires_at) FILTER (
        WHERE pending_expires_at > ${at}::timestamptz AND admission_ip_digest = ${ipDigest ?? null}::bytea
      ) - ${at}::timestamptz))::text AS "ipRetryAfter"
    FROM meeting_poll_voters WHERE poll_id = ${pollId}`.execute(trx)
  const row = rows[0] as (typeof rows)[number]
  return {
    active: Number(row.active),
    fromIp: Number(row.fromIp),
    ipRetryAfter: row.ipRetryAfter === null ? null : Math.max(1, Number(row.ipRetryAfter)),
  }
}

async function votersByMailbox(trx: Db, poll: VoterPoll, keys: readonly Buffer[]) {
  if (keys.length === 0) return []
  const rows = await trx
    .selectFrom('meeting_poll_voters')
    .select([
      'id',
      'email_key',
      sql<boolean>`pending_expires_at IS NOT NULL AND pending_expires_at <= ${poll.at}::timestamptz`.as(
        'expired',
      ),
      sql<MeetingPollVoterState['status']>`CASE WHEN withdrawn_at IS NOT NULL THEN 'withdrawn'
        WHEN verified_at IS NOT NULL THEN 'verified'
        WHEN invited_at IS NOT NULL THEN 'invited' ELSE 'pending' END`.as('status'),
    ])
    .where('poll_id', '=', poll.id)
    .where('email_key', 'in', keys)
    .execute()
  return rows
}

/** Replace a voter row; its votes, credentials and deliveries go with it. */
async function deleteVoter(trx: Db, poll: VoterPoll, voterId: string) {
  await trx
    .deleteFrom('meeting_poll_voters')
    .where('id', '=', voterId)
    .where('poll_id', '=', poll.id)
    .execute()
}

async function voterState(
  trx: Db,
  poll: VoterPoll,
  voterId: string,
): Promise<MeetingPollVoterState> {
  const row = await trx
    .selectFrom('meeting_poll_voters')
    .select([
      'id',
      'name',
      'email',
      'time_zone',
      'locale',
      sql<MeetingPollVoterState['status']>`CASE WHEN withdrawn_at IS NOT NULL THEN 'withdrawn'
        WHEN verified_at IS NOT NULL THEN 'verified'
        WHEN invited_at IS NOT NULL THEN 'invited' ELSE 'pending' END`.as('status'),
    ])
    .where('id', '=', voterId)
    .where('poll_id', '=', poll.id)
    .executeTakeFirstOrThrow()
  return {
    pollId: poll.id,
    voterId: row.id,
    name: row.name,
    email: row.email,
    timeZone: row.time_zone,
    locale: row.locale,
    status: row.status,
    deadlineAt: Temporal.Instant.from(poll.deadline).toString(),
  }
}

/**
 * Results change with admission, verification and invitation; the host revision only with
 * accepted host writes. Voter actions and recovery never move it.
 */
async function advanceRevisions(
  trx: Db,
  poll: VoterPoll,
  options: { host: false } | { host: true; hostRevision: number; results?: boolean },
) {
  const results = !options.host || options.results !== false
  const updated = await trx
    .updateTable('meeting_polls')
    .set((eb) => ({
      ...(options.host ? { host_revision: options.hostRevision + 1 } : {}),
      ...(results ? { results_revision: eb('results_revision', '+', 1) } : {}),
      updated_at: poll.at,
    }))
    .where('id', '=', poll.id)
    .where('organization_id', '=', poll.organizationId)
    .$if(options.host, (query) =>
      query.where('host_revision', '=', (options as { hostRevision: number }).hostRevision),
    )
    .returning('id')
    .executeTakeFirst()
  if (!updated) throw changed()
}

// --- Credentials, mail and counters ----------------------------------------------------------

interface IssuedCredential {
  token: string
  generation: number
  ciphertext: Buffer
}

/**
 * Mint a purpose-bound credential: only its digest and an encrypted copy (for recovery and
 * reminders) are stored. Verification and voting credentials share one generation line per
 * voter, so a delivery's generation names exactly one credential.
 */
async function issueCredential(
  trx: Db,
  poll: VoterPoll,
  voterId: string,
  purpose: CredentialPurpose,
  expiresAt: string,
  secret: string,
): Promise<IssuedCredential> {
  const { rows } = await sql<{ next: number }>`
    SELECT coalesce(max(generation), 0) + 1 AS next FROM meeting_poll_capabilities
    WHERE poll_id = ${poll.id} AND voter_id = ${voterId}
      AND purpose IN ('verification', 'voting')`.execute(trx)
  const generation = Number(rows[0]?.next)
  const token = randomBytes(32).toString('base64url')
  const ciphertext = sealCredential(
    secret,
    { organizationId: poll.organizationId, pollId: poll.id, voterId, generation },
    purpose,
    token,
  )
  await trx
    .insertInto('meeting_poll_capabilities')
    .values({
      organization_id: poll.organizationId,
      poll_id: poll.id,
      voter_id: voterId,
      purpose,
      capability_ciphertext: ciphertext,
      token_digest: meetingPollCapabilityDigest(purpose, token),
      generation,
      expires_at: expiresAt,
      created_at: poll.at,
      updated_at: poll.at,
    })
    .execute()
  return { token, generation, ciphertext }
}

/**
 * End a voter's live credentials of one purpose: consumed by verification or revoked by a
 * rotation or upgrade. The encrypted copy is erased and its queued mail skipped.
 */
async function retireCredentials(
  trx: Db,
  poll: VoterPoll,
  voterId: string,
  purpose: CredentialPurpose,
  how: 'consumed' | 'revoked',
) {
  const retired = await trx
    .updateTable('meeting_poll_capabilities')
    .set({
      ...(how === 'consumed' ? { consumed_at: poll.at } : { revoked_at: poll.at }),
      capability_ciphertext: null,
      updated_at: poll.at,
    })
    .where('poll_id', '=', poll.id)
    .where('voter_id', '=', voterId)
    .where('purpose', '=', purpose)
    .where('revoked_at', 'is', null)
    .where('consumed_at', 'is', null)
    .returning('generation')
    .execute()
  if (retired.length === 0) return
  await trx
    .updateTable('meeting_poll_deliveries')
    .set({
      state: 'skipped',
      terminal_at: poll.at,
      capability_ciphertext: null,
      error_class: 'superseded',
      updated_at: poll.at,
    })
    .where('poll_id', '=', poll.id)
    .where('voter_id', '=', voterId)
    .where('state', '=', 'pending')
    .where('kind', 'in', CREDENTIAL_MAIL)
    .where(
      'generation',
      'in',
      retired.map((row) => row.generation),
    )
    .execute()
}

/**
 * Queue one credential mail. A first delivery of a generation takes sequence 0, so a
 * duplicate is refused by the delivery identity; recovery copies take the next ordinal.
 */
async function queueCredentialMail(
  trx: Db,
  poll: VoterPoll,
  voterId: string,
  kind: CredentialMailKind,
  credential: { generation: number; ciphertext: Buffer },
  sequence: 'first' | 'next',
) {
  let ordinal = 0
  if (sequence === 'next') {
    const { rows } = await sql<{ next: number }>`
      SELECT coalesce(max(sequence) + 1, 0) AS next FROM meeting_poll_deliveries
      WHERE poll_id = ${poll.id} AND voter_id = ${voterId} AND kind = ${kind}
        AND generation = ${credential.generation}`.execute(trx)
    ordinal = Number(rows[0]?.next)
  }
  await trx
    .insertInto('meeting_poll_deliveries')
    .values({
      organization_id: poll.organizationId,
      poll_id: poll.id,
      voter_id: voterId,
      kind,
      generation: credential.generation,
      sequence: ordinal,
      due_at: poll.at,
      capability_ciphertext: credential.ciphertext,
      created_at: poll.at,
      updated_at: poll.at,
    })
    .execute()
}

/**
 * A new credential was mailed to the mailbox (enrollment, invitation or verification), so
 * its recovery count restarts; resend does the same in its own counter update. Resend
 * counts, reminder receipts and opt-outs never reset.
 */
async function newCurrentCredential(
  trx: Db,
  poll: VoterPoll,
  emailKey: Buffer,
  { clearRemoval }: { clearRemoval: boolean },
) {
  await trx
    .insertInto('meeting_poll_mailbox_counters')
    .values({
      organization_id: poll.organizationId,
      poll_id: poll.id,
      email_key: emailKey,
      created_at: poll.at,
      updated_at: poll.at,
    })
    .onConflict((conflict) =>
      conflict.columns(['poll_id', 'email_key']).doUpdateSet({
        recovery_count: 0,
        last_recovery_at: null,
        ...(clearRemoval ? { removed_at: null } : {}),
        updated_at: poll.at,
      }),
    )
    .execute()
}

/** The mailbox's counter row, created when missing, with cooldowns judged at `poll.at`. */
async function ensureCounter(trx: Db, poll: VoterPoll, emailKey: Buffer) {
  await trx
    .insertInto('meeting_poll_mailbox_counters')
    .values({
      organization_id: poll.organizationId,
      poll_id: poll.id,
      email_key: emailKey,
      created_at: poll.at,
      updated_at: poll.at,
    })
    .onConflict((conflict) => conflict.columns(['poll_id', 'email_key']).doNothing())
    .execute()
  const recoveryCooldown = MEETING_POLL_LIMITS.recoveryCooldownSeconds
  const resendCooldown = MEETING_POLL_LIMITS.resendCooldownSeconds
  const row = await trx
    .selectFrom('meeting_poll_mailbox_counters')
    .select([
      'resend_count',
      'recovery_count',
      sql<boolean>`last_recovery_at IS NOT NULL AND last_recovery_at
        + make_interval(secs => ${recoveryCooldown}) > ${poll.at}::timestamptz`.as(
        'recoveryCooling',
      ),
      sql<string | null>`CASE WHEN last_resend_at + make_interval(secs => ${resendCooldown})
        > ${poll.at}::timestamptz THEN ceil(extract(epoch FROM last_resend_at
        + make_interval(secs => ${resendCooldown}) - ${poll.at}::timestamptz))::text END`.as(
        'resendRetryAfter',
      ),
    ])
    .where('poll_id', '=', poll.id)
    .where('email_key', '=', emailKey)
    .executeTakeFirstOrThrow()
  return {
    resend_count: row.resend_count,
    recovery_count: row.recovery_count,
    recoveryCooling: row.recoveryCooling,
    resendRetryAfter:
      row.resendRetryAfter === null ? null : Math.max(1, Number(row.resendRetryAfter)),
  }
}

// --- Validation ------------------------------------------------------------------------------

function requireSecret(secret: unknown): string {
  if (typeof secret !== 'string' || secret.length < 16)
    throw new TypeError('Meeting poll voter services need the installation secret')
  return secret
}

/** A credential of the wrong shape is indistinguishable from an unknown one. */
function validToken(token: unknown): string {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw pollNotFound()
  return token
}

/** The shared invitee email rule, then one normalized (lowercase) mailbox per poll. */
function validEmail(value: unknown): string {
  const email = cleanInviteeEmail(value)?.toLowerCase()
  if (email === undefined) throw invalidVoter('email must be a valid email address')
  return email
}

function validPerson(input: { name?: unknown; email?: unknown }) {
  const name = cleanText(input.name, { max: MAX_NAME })
  if (name === undefined)
    throw invalidVoter(
      `name must be 1 to ${MAX_NAME} characters on one line, without control characters`,
    )
  return { name, email: validEmail(input.email) }
}

function validLocale(value: unknown): string {
  if (value === undefined) return 'en'
  const locale = interfaceLanguage(value)
  if (locale === undefined) throw invalidVoter('locale must be a supported language')
  return locale
}

function validInvitation(input: InviteMeetingPollVotersInput) {
  if (!input || typeof input !== 'object') throw invalidVoter('The request must be an object')
  const idempotencyKey = validIdempotencyKey(input.idempotencyKey)
  if (!Array.isArray(input.invitees) || input.invitees.length === 0)
    throw invalidVoter('invitees must list at least one person')
  if (input.invitees.length > MEETING_POLL_LIMITS.maxEnrollments)
    throw new DomainError(
      'invalid',
      'poll_limit_exceeded',
      `A batch can invite at most ${MEETING_POLL_LIMITS.maxEnrollments} people`,
    )
  const seen = new Set<string>()
  const invitees: { name: string; email: string; locale?: string; timeZone?: string }[] = []
  for (const entry of input.invitees) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw invalidVoter('Each invitee must be an object')
    for (const field of Object.keys(entry))
      if (!INVITEE_FIELDS.has(field)) throw invalidVoter(`Unknown invitee field ${field}`)
    const person = validPerson(entry)
    const locale = entry.locale === undefined ? undefined : validLocale(entry.locale)
    const timeZone =
      entry.timeZone === undefined ? undefined : validTimeZone(entry.timeZone, 'timeZone')
    // One mailbox per poll: a repeated address in one batch is the same person.
    if (seen.has(person.email)) continue
    seen.add(person.email)
    invitees.push({
      ...person,
      ...(locale !== undefined && { locale }),
      ...(timeZone !== undefined && { timeZone }),
    })
  }
  return { id: input.id, invitees, idempotencyKey }
}

function earlier(a: string, b: string): string {
  return Temporal.Instant.compare(Temporal.Instant.from(a), Temporal.Instant.from(b)) <= 0
    ? Temporal.Instant.from(a).toString()
    : Temporal.Instant.from(b).toString()
}
