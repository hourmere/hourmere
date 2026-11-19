// Synthetic database-backed public states, without enabling poll creation transports.
import { randomBytes } from 'node:crypto'
import type { Db } from '../../packages/db/src/index.ts'
import { ensureMeetingPollKey } from '../../packages/scheduling/src/meeting-poll-key.ts'
import {
  meetingPollCapabilityDigest,
  meetingPollMailboxKey,
} from '../../packages/scheduling/src/meeting-poll-voters.ts'
import { meetingPollPublicTokenDigest } from '../../packages/scheduling/src/meeting-polls.ts'
import { AUDIT_NOW, AUDIT_TITLE } from './audit-data.ts'

export type PollAuditState = 'enroll' | 'verify' | 'vote' | 'saved' | 'withdrawn' | 'closed'

export async function seedPollAuditData(
  db: Db,
  host: { organizationId: string; userId: string },
  eventTypeId: string,
  secret: string,
  state: PollAuditState,
) {
  const publicToken = randomBytes(32).toString('base64url')
  const voterToken = randomBytes(32).toString('base64url')
  const optOutToken = randomBytes(32).toString('base64url')
  return db.transaction().execute(async (trx) => {
    await ensureMeetingPollKey(trx, secret)
    const deadline = '2030-01-08T10:00:00.000Z'
    const poll = await trx
      .insertInto('meeting_polls')
      .values({
        organization_id: host.organizationId,
        event_type_id: eventTypeId,
        created_by_user_id: host.userId,
        title: AUDIT_TITLE,
        duration_minutes: 30,
        display_time_zone: 'America/New_York',
        settings_snapshot: {
          questions: [
            {
              id: 'note',
              type: 'short_text',
              label: 'Discussion topics / 讨论内容',
              required: false,
            },
          ],
        },
        settings_fingerprint: Buffer.alloc(32),
        admission_mode: 'public_link',
        visibility: 'aggregate',
        public_token_digest: meetingPollPublicTokenDigest(publicToken),
        deadline_at: deadline,
        created_at: AUDIT_NOW,
        ...(state === 'closed' ? { status: 'closed', closed_at: AUDIT_NOW } : {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const slots = await trx
      .insertInto('meeting_poll_slots')
      .values(
        [0, 1].map((position) => ({
          organization_id: host.organizationId,
          poll_id: poll.id,
          position,
          start_at: `2030-01-09T${14 + position}:00:00.000Z`,
          end_at: `2030-01-09T${14 + position}:30:00.000Z`,
        })),
      )
      .returning('id')
      .execute()
    const pending = state === 'verify'
    const saved = state === 'saved' || state === 'closed'
    const voter = await trx
      .insertInto('meeting_poll_voters')
      .values({
        organization_id: host.organizationId,
        poll_id: poll.id,
        name: 'Synthetic poll voter / 投票者',
        email: 'poll-voter@hourmere.invalid',
        email_key: meetingPollMailboxKey(secret, poll.id, 'poll-voter@hourmere.invalid'),
        time_zone: 'America/New_York',
        locale: 'en',
        created_at: AUDIT_NOW,
        ...(pending
          ? {
              pending_expires_at: '2030-01-07T11:00:00.000Z',
              admission_ip_digest: Buffer.alloc(32),
            }
          : { verified_at: AUDIT_NOW }),
        ...(state === 'withdrawn' ? { withdrawn_at: AUDIT_NOW, ballot_revision: 1 } : {}),
        ...(saved
          ? {
              ballot_submitted_at: AUDIT_NOW,
              join_consent_at: AUDIT_NOW,
              ballot_revision: 1,
              responses: { note: 'Synthetic answer / 合成回答' },
            }
          : {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    if (saved)
      await trx
        .insertInto('meeting_poll_votes')
        .values(
          slots.map((slot, index) => ({
            organization_id: host.organizationId,
            poll_id: poll.id,
            voter_id: voter.id,
            slot_id: slot.id,
            value: index === 0 ? 'yes' : 'if_need_be',
          })),
        )
        .execute()
    await trx
      .insertInto('meeting_poll_capabilities')
      .values([
        {
          organization_id: host.organizationId,
          poll_id: poll.id,
          voter_id: voter.id,
          purpose: pending ? 'verification' : 'voting',
          token_digest: meetingPollCapabilityDigest(
            pending ? 'verification' : 'voting',
            voterToken,
          ),
          expires_at: pending ? '2030-01-07T11:00:00.000Z' : deadline,
          created_at: AUDIT_NOW,
        },
        {
          organization_id: host.organizationId,
          poll_id: poll.id,
          voter_id: voter.id,
          purpose: 'reminder_opt_out',
          token_digest: meetingPollCapabilityDigest('reminder_opt_out', optOutToken),
          expires_at: deadline,
          created_at: AUDIT_NOW,
        },
      ])
      .execute()
    return { publicToken, voterToken, optOutToken, pollId: poll.id }
  })
}
