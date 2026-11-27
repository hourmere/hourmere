import { interfaceLanguage } from '@hourmere/core/language'
import type { Db } from '@hourmere/db'
import { defineJob, type EnqueueOptions } from '@hourmere/jobs'
import { type Mailer, ownershipTransferEmail } from '@hourmere/mail'
import { sql } from 'kysely'
import { z } from 'zod'

const name = 'ownership-transfer-email'
const recipient = { organizationId: z.uuid(), userId: z.uuid() }
const payload = z.discriminatedUnion('kind', [
  z.strictObject({ ...recipient, kind: z.literal('offered'), transferId: z.uuid() }),
  z.strictObject({ ...recipient, kind: z.literal('confirmed') }),
])
type Notice = z.infer<typeof payload>

export interface OwnershipTransferNoticeQueue {
  enqueue(job: typeof name, notice: Notice, options: EnqueueOptions): Promise<string | null>
}

type TransferNotice = { organizationId: string; userIds: readonly string[] } & (
  | { kind: 'offered'; transferId: string }
  | { kind: 'confirmed' }
)

export async function enqueueOwnershipTransferNotice(
  queue: OwnershipTransferNoticeQueue,
  trx: Db,
  { userIds, ...notice }: TransferNotice,
) {
  if (!trx.isTransaction) throw new Error('Ownership transfer email requires a transaction')
  for (const userId of new Set(userIds)) {
    const id = await queue.enqueue(name, { ...notice, userId }, { transaction: trx })
    if (!id) throw new Error('Ownership transfer email could not be queued')
  }
}

export function ownershipTransferNoticeJob({
  db,
  publicUrl,
  mailer,
}: {
  db: Db
  publicUrl: string
  mailer: Mailer
}) {
  const link = new URL('/app/settings#team-members', publicUrl)
  return defineJob({
    name,
    payload,
    handler: async (notice, { signal }) => {
      try {
        let query = db
          .selectFrom('auth.member as member')
          .innerJoin('auth.organization as team', 'team.id', 'member.organizationId')
          .innerJoin('auth.user as account', 'account.id', 'member.userId')
          .leftJoin('profiles as profile', 'profile.user_id', 'account.id')
          .select(['account.email', 'team.name', 'profile.locale'])
          .where('team.id', '=', notice.organizationId)
          .where('account.id', '=', notice.userId)
          .where('account.emailVerified', '=', true)
        if (notice.kind === 'offered') {
          query = query.where(({ exists, selectFrom }) =>
            exists(
              selectFrom('organization_ownership_transfers as transfer')
                .select('transfer.id')
                .where('transfer.id', '=', notice.transferId)
                .whereRef('transfer.organization_id', '=', 'team.id')
                .whereRef('transfer.target_user_id', '=', 'account.id')
                .whereRef('transfer.target_membership_id', '=', 'member.id')
                .where('transfer.state', '=', 'pending')
                .where('transfer.expires_at', '>', sql<Date>`clock_timestamp()`),
            ),
          )
        }
        const recipient = await query.executeTakeFirst()
        if (!recipient) return
        await mailer.send(
          ownershipTransferEmail({
            to: recipient.email,
            language: interfaceLanguage(recipient.locale) ?? 'en',
            kind: notice.kind,
            teamName: recipient.name,
            link,
          }),
          { signal },
        )
      } catch {
        throw new Error('Ownership transfer email could not be sent')
      }
    },
  })
}
