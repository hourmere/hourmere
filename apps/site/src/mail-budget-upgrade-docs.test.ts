import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = process.env.HOURMERE_DOCS_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))
const read = (path: string) => readFileSync(join(root, path), 'utf8').replace(/\s+/g, ' ')
const siteDocs = 'apps/site/src/content/docs/docs'
const notes = [
  {
    path: 'CHANGELOG.md',
    text:
      read('CHANGELOG.md')
        .split('- **Coordinate the mail-budget upgrade (migration 0040).**')[1]
        ?.split('- **Rebuild Google busy snapshots')[0] ?? '',
  },
  {
    path: `${siteDocs}/self-hosting.md`,
    text:
      read(`${siteDocs}/self-hosting.md`)
        .split(
          '**Migration 0040 requires stopping all old senders to enforce the mail budgets.**',
        )[1]
        ?.split('**Migration 0039')[0] ?? '',
  },
]

describe('mail-budget upgrade documentation', () => {
  it.each(notes)('explains schema compatibility and uncounted old workers in $path', ({ text }) => {
    expect(text).toContain('0040_notification_mail_limits.sql')
    expect(text).toMatch(/schema-compatible (?:with mixed old\/new processes )?during the switch/)
    expect(text).toContain(
      "old inserts default to `outcome = 'sent'` and NULL `suppression_reason`",
    )
    expect(text).toContain("old reads filter `outcome = 'sent'`")
    expect(text).toMatch(/Old workers (?:nevertheless send|would still send) without being counted/)
  })

  it.each(notes)('builds then stops every old sender before new startup in $path', ({ text }) => {
    expect(text).toMatch(/(?:every old|all old) `web`, `all` and `worker` process/)
    expect(text).toContain('including any on other hosts')
    expect(text).toContain('build → stop app (and any separate worker) → up')
    expect(text).toMatch(
      /`docker compose build`, `docker compose stop app`, `docker compose stop worker` if configured, then `docker compose up -d --wait`/,
    )
    expect(text).toMatch(/(?:Keep|Leave) PostgreSQL running/)
    expect(text).toContain('the first new process applies')
  })

  it('documents sign-in defaults and their shared instance reserve without old headroom advice', () => {
    const config = read(`${siteDocs}/configuration.md`)
    expect(config).toContain('| `SIGN_IN_MAIL_MAX_PER_HOUR` | `5` |')
    expect(config).toContain('| `SIGN_IN_MAIL_MAX_PER_DAY` | `20` |')
    expect(config).toContain('host and sign-in mail may use up to 120% (rounded down)')
    expect(config).toContain('every sign-in request retains the same HTTP response')
    expect(config).not.toMatch(
      /Sign-in\/authentication mail is outside|leaving room for.*sign-in mail/,
    )
  })

  it('explains recipient isolation, normalization and secret-derived counter transitions', () => {
    const notifications = read(`${siteDocs}/notifications.md`)
    expect(notifications).toContain('sign-in and booking recipient counts do not mix')
    expect(notifications).toContain('Recipient normalization is trim + lowercase only')
    expect(notifications).toContain('Plus-addressing, Gmail dots and IDN variants are not merged')
    expect(notifications).toContain('the instance cap is the backstop')
    expect(notifications).toContain('HMAC-SHA-256 with a key derived from `BETTER_AUTH_SECRET`')
    expect(notifications).toContain('recipient-count gap lasts at most 24 hours')
    expect(notifications).toContain('old hashes are purged after two days')
    expect(notifications).toContain('Rotating it resets the recipient counters')
    expect(notifications).toContain('instance counts remain intact')
  })

  it('describes shared serialization and terminal sign-in suppression', () => {
    const notifications = read(`${siteDocs}/notifications.md`)
    expect(notifications).toContain('Notification and sign-in sends are serialized per instance')
    expect(notifications).toContain('slow SMTP holds up other notification and sign-in sends')
    expect(notifications).toContain('deletes the outbox row')
    expect(notifications).toContain('Retrying that job never resends it')
    expect(notifications).toContain('recipient hash and reason only')
  })
})
