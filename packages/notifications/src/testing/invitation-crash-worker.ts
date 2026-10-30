import { createDb, type Db } from '@hourmere/db'
import { createJobs, defineJob } from '@hourmere/jobs'
import { createSmtpMailer } from '@hourmere/mail'
import pg from 'pg'
import {
  createInvitationEmailRepairer,
  invitationEmailJob,
  invitationEmailRepairJob,
} from '../invitation-email.ts'
import { deliverInvitationEmail } from '../invitation-sender.ts'

// A separate OS process is necessary: killing an in-process promise cannot prove recovery.
process.once(
  'message',
  async (config: { url: string; smtpUrl: string; phase: 'claim' | 'smtp' | 'normal' }) => {
    const pool = new pg.Pool({ connectionString: config.url, max: 2 })
    const db = createDb(pool)
    const park = async (event: string) => {
      process.send?.(event)
      await new Promise<void>(() => {})
    }
    let commits = 0
    const senderDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'transaction') return Reflect.get(target, property, receiver)
        return () => {
          const builder = target.transaction()
          return new Proxy(builder, {
            get(transaction, key, transactionReceiver) {
              if (key !== 'execute') return Reflect.get(transaction, key, transactionReceiver)
              return async (callback: Parameters<typeof builder.execute>[0]) => {
                const result = await transaction.execute(callback)
                if (++commits === 1 && config.phase === 'claim') await park('claim_committed')
                return result
              }
            },
          })
        }
      },
    }) as Db
    const smtp = createSmtpMailer({ url: config.smtpUrl, from: 'sender@example.test' })
    const queueOnly = invitationEmailJob()
    const sender = defineJob({
      ...queueOnly,
      handler: (payload, run) =>
        deliverInvitationEmail(
          {
            db: senderDb,
            publicUrl: 'https://invitation.example.test',
            secret: 'synthetic-crash-audit-secret',
            smtpConfigured: true,
            mailer: {
              async send(message, options) {
                await smtp.send(message, options)
                if (config.phase === 'smtp') await park('smtp_accepted')
              },
            },
            log() {},
          },
          payload,
          run.signal,
          run.id,
        ),
    })
    const repair = (): Promise<void> => createInvitationEmailRepairer({ db, queue: jobs })()
    const jobs = createJobs({
      connectionString: config.url,
      definitions: [sender, invitationEmailRepairJob(repair)] as const,
      work: true,
      migrate: false,
      maxConnections: 2,
      pollingIntervalSeconds: 0.5,
      shutdownTimeoutMs: 500,
      log() {},
    })
    const stop = async () => {
      try {
        await jobs.stop()
        await pool.end()
        process.disconnect?.()
      } catch {
        process.exitCode = 1
      }
    }
    process.once('SIGTERM', () => void stop())
    process.once('disconnect', () => void stop())
    try {
      await jobs.start()
      await repair()
      process.send?.('ready')
    } catch {
      process.send?.('startup_failed')
      await stop()
      process.exitCode = 1
    }
  },
)
