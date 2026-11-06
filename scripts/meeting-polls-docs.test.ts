import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAX_GUESTS } from '../packages/scheduling/src/bookings.ts'

const document = readFileSync(new URL('../docs/meeting-polls.md', import.meta.url), 'utf8')

const limits = [
  ['Candidates per poll', '2–20'],
  ['Enrollments per poll', '0–40'],
  ['Attendees per booking', '1–11'],
  ['Pending enrollment expiry', '1 hour'],
  ['Public pending reservations per IP/poll', '3'],
  ['Invitation resend cooldown', '15 minutes'],
  ['Invitation resend cap', '3 per poll/mailbox'],
  ['Deadline after creation', '1 hour–30 days'],
  ['Reminder lead time', '24 hours'],
] as const

function verifyLimit(source: string, label: string, value: string) {
  const rows = source
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells[0] === label)
  expect(rows, `${label}: exactly one limit row`).toHaveLength(1)
  expect(rows[0]?.[1], label).toBe(value)
}

function verifyLimits(source: string) {
  for (const [label, value] of limits) verifyLimit(source, label, value)
}

describe('meeting poll design numeric limits', () => {
  it('ties the attendee cap to the booking service guest limit plus the booker', () => {
    verifyLimit(document, 'Attendees per booking', `1–${MAX_GUESTS + 1}`)
  })

  it.each(limits)('pins %s to %s', (label, value) => {
    verifyLimit(document, label, value)
  })

  it.each([
    ['candidate minimum', 'Candidates per poll', '2–20', '1–20'],
    ['candidate maximum', 'Candidates per poll', '2–20', '2–21'],
    ['enrollment minimum', 'Enrollments per poll', '0–40', '1–40'],
    ['enrollment maximum', 'Enrollments per poll', '0–40', '0–41'],
    ['attendee minimum', 'Attendees per booking', '1–11', '0–11'],
    ['attendee maximum', 'Attendees per booking', '1–11', '1–12'],
    ['pending enrollment expiry', 'Pending enrollment expiry', '1 hour', '2 hours'],
    ['public pending IP cap', 'Public pending reservations per IP/poll', '3', '40'],
    ['invitation resend cooldown', 'Invitation resend cooldown', '15 minutes', '1 minute'],
    ['invitation resend cap', 'Invitation resend cap', '3 per poll/mailbox', '4 per poll/mailbox'],
    ['deadline minimum', 'Deadline after creation', '1 hour–30 days', '2 hours–30 days'],
    ['deadline maximum', 'Deadline after creation', '1 hour–30 days', '1 hour–31 days'],
    ['reminder lead time', 'Reminder lead time', '24 hours', '48 hours'],
  ])('rejects a source-copy change to the %s', (_name, label, before, after) => {
    verifyLimits(document)
    const mutated = document
      .split('\n')
      .map((line) => {
        const cells = line.split('|')
        if (cells[1]?.trim() !== label) return line
        cells[2] = cells[2]?.replace(before, after) ?? ''
        return cells.join('|')
      })
      .join('\n')
    expect(mutated, 'source-copy mutation must change the limit').not.toBe(document)
    expect(() => verifyLimits(mutated)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    verifyLimits(document)
  })
})

function tableRow(source: string, label: string) {
  const row = source.split('\n').find((line) => line.startsWith(`| ${label}`))
  expect(row, `table row ${label}`).toBeDefined()
  return (
    row
      ?.split('|')
      .slice(1, -1)
      .map((cell) => cell.trim()) ?? []
  )
}

const protections = [
  {
    name: 'deadline preserves own-ballot reads until retention',
    pattern:
      /Voting expiry at the deadline\s+disables writes, but the retained digest still authenticates read-only own-ballot access\s+until poll retention\/deletion; removal\/revocation invalidates reads as well/,
    before:
      'disables writes, but the retained digest still authenticates read-only own-ballot access',
    after: 'disables both writes and reads',
  },
  {
    name: 'withdrawal permits explicit reactivation with consent and capacity',
    pattern:
      /Reactivation before closing requires\s+that same capability, renewed consent and an atomic capacity check\. Withdrawal suspends\s+voting authority but retains the credential solely for read-only access and explicit\s+reactivation/,
    before: 'voting authority but retains the credential solely for read-only access and explicit',
    after: 'voting authority and destroys the credential needed for',
  },
  {
    name: 'invited mode never mints a public link',
    pattern:
      /Invited mode returns\s+metadata without a link and rejects rotate-link with `poll_event_unsupported`/,
    before: 'metadata without a link and rejects rotate-link with `poll_event_unsupported`',
    after: 'a public link when rotate-link is requested',
  },
  {
    name: 'host deadline results link works before full UI lands',
    pattern:
      /B4 host deadline mail\s+targets the authenticated D1 results REST endpoint until D4b supplies the results page/,
    before:
      'targets the authenticated D1 results REST endpoint until D4b supplies the results page',
    after: 'targets the unavailable D4b page from introduction',
  },
  {
    name: 'public-only pending expiry',
    pattern:
      /Only public-link self-enrollment and its recovery attempts have a one-hour pending expiry/,
    before: 'Only public-link self-enrollment and its recovery attempts',
    after: 'Every unverified enrollment and invitation',
  },
  {
    name: 'durable invited place and credential',
    pattern:
      /Host invitations reserve capacity atomically[\s\S]*?keep their place and\s+valid voting credential until the deadline, withdrawal, removal or host revocation/,
    before: 'valid voting credential until the deadline, withdrawal, removal or host revocation',
    after: 'valid voting credential for one hour',
  },
  {
    name: 'invited places count toward enrollment cap',
    pattern:
      /Count active verified voters,\s+active host invitations \(verified or not\), and unexpired public pending reservations once\s+each toward the 40-place enrollment cap/,
    before: 'active host invitations (verified or not)',
    after: 'only verified host invitations',
  },
  {
    name: 'direct reminder voting credential',
    pattern:
      /Reminders carry the still-valid voting credential directly[\s\S]*?including for unverified invitees and when enrollment capacity is full; no recovery detour/,
    before: 'Reminders carry the still-valid voting credential directly',
    after: 'Reminders carry only a recovery link',
  },
  {
    name: 'atomic bulk invitation capacity rejection',
    pattern:
      /Invitation batches are all-or-nothing:[\s\S]*?reject the entire batch with 409 `poll_full`,\s+without rows or mail intents[\s\S]*?400\s+`poll_limit_exceeded`; no prefix is accepted/,
    before: 'reject the entire batch with 409 `poll_full`',
    after: 'accept a prefix with 202',
  },
  {
    name: 'mailbox digest storage',
    pattern:
      /`email_key` is a domain-separated keyed HMAC digest of the normalized mailbox, never\s+plaintext/,
    before: 'domain-separated keyed HMAC digest',
    after: 'plaintext copy',
  },
  {
    name: 'purpose-specific opt-out credential storage',
    pattern:
      /\| `meeting_poll_capabilities`[^\n]*`purpose` \(verification\/voting\/reminder_opt_out\)[^\n]*`token_digest`[^\n]*`generation`[^\n]*`expires_at`[^\n]*`revoked_at`/,
    before: '(verification/voting/reminder_opt_out)',
    after: '(verification/voting)',
  },
  {
    name: 'resend ledger survives voter recreation',
    pattern:
      /\| `meeting_poll_mailbox_counters`[^\n]*`email_key`[^\n]*`resend_count`[^\n]*`last_resend_at`[^\n]*`reminder_consumed_at`[^\n]*no voter FK, survives voter expiry\/removal\/recreation/,
    before: 'no voter FK, survives voter expiry/removal/recreation',
    after: 'voter FK with deletion cascade',
  },
  {
    name: 'public POST read scope',
    pattern:
      /Public POST `read` is `booking_read` with `optional_key` authentication\s+and accepts `full`, `read` or `bookings`/,
    before: 'Public POST `read` is `booking_read`',
    after: 'Public POST `read` is `booking_write`',
  },
  {
    name: 'link rotation write scope',
    pattern:
      /rotate-link and bulk remove-unverified are host\s+booking writes, requiring `full` or `bookings`/,
    before: 'booking writes, requiring `full` or `bookings`',
    after: 'booking reads, accepting `read`',
  },
  {
    name: 'concrete existing request limits and fill risk',
    pattern:
      /60 seconds: page\/slots 120, book 10, manage 30[\s\S]*?40 enrollments in roughly four minute windows and refill with 40\/hour[\s\S]*?80 admission requests/,
    before: 'page/slots 120, book 10, manage 30',
    after: 'page/slots 120, book 100, manage 30',
  },
  {
    name: 'atomic three-pending IP mitigation',
    pattern:
      /most 3 concurrent unexpired public pending reservations per trusted IP per poll, checked\s+atomically under the poll lock; 40 pending places therefore need at least 14 IP addresses/,
    before: 'most 3 concurrent unexpired public pending reservations',
    after: 'most 40 concurrent unexpired public pending reservations',
  },
  {
    name: 'bulk public cleanup preserves invited places',
    pattern: /Hosts can bulk remove unverified public enrollees \(never host invitees\)/,
    before: 'unverified public enrollees (never host invitees)',
    after: 'all unverified people including host invitees',
  },
] as const

describe('meeting poll design protections', () => {
  it.each(protections)('specifies $name', ({ pattern }) => {
    expect(document).toMatch(pattern)
  })

  it.each(protections)(
    'rejects a source-copy regression of $name',
    ({ pattern, before, after }) => {
      expect(document).toMatch(pattern)
      const mutated = document.replace(before, after)
      expect(mutated).not.toBe(document)
      expect(() => expect(mutated).toMatch(pattern)).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
      expect(document).toMatch(pattern)
    },
  )
})

function verifyPlan(source: string) {
  const stages = [
    'A1',
    'A2',
    'A3a',
    'A3b',
    'A4',
    'B1',
    'B2',
    'B3',
    'B4',
    'C1',
    'C2a',
    'C2b',
    'C3',
    'D1',
    'D2',
    'D3',
    'D4a',
    'D4b',
    'E1',
    'E2',
  ]
  for (const [index, stage] of stages.entries()) {
    const cells = tableRow(source, `${stage} `)
    expect(cells, stage).toHaveLength(5)
    expect(cells[1], `${stage} dependency`).toBe(stages[index - 1] ?? 'None')
    expect(cells[2], `${stage} ownership`).not.toBe('')
    expect(cells[3], `${stage} flag`).toMatch(/^No flag;/)
  }
  const acceptance = (stage: string) => tableRow(source, `${stage} `)[4]
  expect(acceptance('A2')).toContain('on polls without voters')
  expect(acceptance('A2')).toMatch(
    /Voter-dependent results, removal and privacy cascades belong to A4/,
  )
  expect(acceptance('A3a')).toContain('Enroll/invite/verify/recover/resend')
  expect(acceptance('A3b')).toContain(
    'Submit/replace full ballots, withdraw/reactivate and opt-out',
  )
  expect(acceptance('A3b')).toContain('transaction waiting across the deadline race')
  expect(acceptance('B2')).toMatch(
    /CLI secrets must be read from stdin from this first step, never argv/,
  )
  expect(acceptance('D4a')).toContain('invitation roster with invite/resend/remove')
  expect(acceptance('D4b')).toContain('conditional acknowledgment/finalize, close/cancel/delete')
}

describe('meeting poll day-sized implementation plan', () => {
  it('orders split steps, ownership and flags with secure CLI input from introduction', () => {
    verifyPlan(document)
  })

  it.each([
    ['enrollment split', '| A3a Storage', '| A3 Storage'],
    ['ballot split', '| A3b Storage', '| A3 Storage'],
    ['host creation split', '| D4a Agent', '| D4 Agent'],
    ['host results split', '| D4b Agent', '| D4 Agent'],
    [
      'dependency order',
      '| A3b | None; internal service only',
      '| A2 | None; internal service only',
    ],
    ['voter-free lifecycle scope', 'on polls without voters', 'on polls with voter operations'],
    [
      'deadline race coverage',
      'transaction waiting across the deadline race',
      'request arriving before the deadline',
    ],
    [
      'early CLI secret safety',
      'CLI secrets must be read from stdin from this first step, never argv',
      'CLI secrets use argv until D3',
    ],
    ['explicit flag state', 'No flag; host creation UI available', 'Unspecified'],
    [
      'transport ownership',
      'All public REST operations, matching MCP tools and CLI commands together',
      '',
    ],
  ])('rejects a source-copy regression of %s', (_name, before, after) => {
    verifyPlan(document)
    const mutated = document.replace(before, after)
    expect(mutated).not.toBe(document)
    expect(() => verifyPlan(mutated)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    verifyPlan(document)
  })
})
