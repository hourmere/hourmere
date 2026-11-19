// Offline maintenance only: run inside the server container against its instance database.
import { createDb, createPool } from '@hourmere/db'
import { createSmtpMailer } from '@hourmere/mail'
import {
  createDomainRetirementChallenge,
  notifyDomainRetirement,
  retireSsoDomain,
} from './sso-domain-retirement.ts'

const [operation, id, generation, requestingTeamId, ...extra] = process.argv.slice(2)
const url = process.env.DATABASE_URL
const publicUrl = process.env.PUBLIC_URL
if (
  !url ||
  !publicUrl ||
  !id ||
  extra.length ||
  !['challenge', 'retire', 'notify'].includes(operation ?? '') ||
  (operation === 'challenge' ? !generation || !requestingTeamId : generation !== undefined)
) {
  console.error(
    'Usage: challenge <claim-id> <generation> <requesting-team-id> | retire <challenge-id> | notify <challenge-id>; DATABASE_URL and PUBLIC_URL are required',
  )
  process.exitCode = 1
} else {
  const pool = createPool(url)
  const db = createDb(pool)
  let retired = false
  try {
    const deps = { db, publicUrl }
    if (operation === 'challenge') {
      // This fresh public DNS proof is deliberately displayed once, as with ordinary challenges.
      console.log(
        JSON.stringify(
          await createDomainRetirementChallenge(
            deps,
            id,
            Number(generation),
            requestingTeamId as string,
          ),
        ),
      )
    } else {
      if (operation === 'retire') {
        await retireSsoDomain(deps, id)
        retired = true
      }
      if (!process.env.SMTP_URL || !process.env.MAIL_FROM) throw new Error('notification pending')
      const result = await notifyDomainRetirement(
        {
          ...deps,
          mailer: createSmtpMailer({ url: process.env.SMTP_URL, from: process.env.MAIL_FROM }),
        },
        id,
      )
      console.log(
        result.pending
          ? 'Owner notifications remain pending; run notify again with this challenge ID'
          : 'Completed; no owner notifications remain pending',
      )
    }
  } catch {
    // Driver, resolver and SMTP errors can contain private addresses or proof material.
    console.error(
      retired
        ? 'Retirement committed; owner notification delivery did not complete. Retry notify with the same challenge ID.'
        : 'Maintenance did not complete. Check the inputs and configuration; retry the same operation.',
    )
    process.exitCode = 1
  } finally {
    await db.destroy()
  }
}
