import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PUBLIC_RATE_LIMITS, type RateLimit } from '../apps/server/src/rate-limit.ts'
import { MAX_GUESTS } from '../packages/scheduling/src/bookings.ts'
import {
  MEETING_POLL_LIMITS,
  MEETING_POLL_RETENTION,
} from '../packages/scheduling/src/meeting-poll-policy.ts'

const document = readFileSync(new URL('../docs/meeting-polls.md', import.meta.url), 'utf8')
const dataModel = readFileSync(new URL('../docs/data-model.md', import.meta.url), 'utf8')

const limits = [
  ['Candidates per poll', '2–20'],
  ['Enrollments per poll', '0–40'],
  ['Attendees per booking', '1–11'],
  ['Pending enrollment expiry', '1 hour'],
  ['Public pending reservations per IP/poll', '3'],
  ['Invitation resend cooldown', '15 minutes'],
  ['Invitation resend cap', '3 per poll/mailbox'],
  ['Recovery delivery cooldown', '15 minutes'],
  ['Recovery delivery cap', '3 per mailbox credential'],
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
    ['recovery cooldown', 'Recovery delivery cooldown', '15 minutes', '1 minute'],
    ['recovery cap', 'Recovery delivery cap', '3 per mailbox credential', '3 per poll/mailbox'],
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
      /Invited mode returns\s+metadata without a link and rejects rotate-link with 409 `poll_link_unavailable`/,
    before: 'metadata without a link and rejects rotate-link with 409 `poll_link_unavailable`',
    after: 'a public link when rotate-link is requested',
  },
  {
    name: 'host deadline results link works before full UI lands',
    pattern:
      /B4 host deadline mail\s+targets the authenticated D1 results REST endpoint until D4a supplies the results page/,
    before:
      'targets the authenticated D1 results REST endpoint until D4a supplies the results page',
    after: 'targets the unavailable D4a page from introduction',
  },
  {
    name: 'public-only pending expiry',
    pattern: /Only public-link self-enrollment has a one-hour pending expiry/,
    before: 'Only public-link self-enrollment has',
    after: 'Every unverified enrollment and invitation has',
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
  {
    name: 'voter activity never changes the host revision',
    pattern:
      /`host_revision` changes only on accepted host writes[\s\S]*?voter\s+actions, recovery, reminder opt-out, public pending expiry and the\s+derived deadline transition never change it/,
    before: 'derived deadline transition never change it',
    after: 'derived deadline transition also increment it',
  },
  {
    name: 'host remedies check only the host revision',
    pattern:
      /Resend, remove-voter, remove-unverified,\s+rotate-link, close, cancel and delete require `expectedHostRevision`/,
    before: 'rotate-link, close, cancel and delete require `expectedHostRevision`',
    after: 'rotate-link, close, cancel and delete require `expectedResultsRevision`',
  },
  {
    name: 'only finalize checks the results revision',
    pattern: /Only finalize checks it, through\s+`expectedResultsRevision`/,
    before: 'Only finalize checks it',
    after: 'Every host write checks it',
  },
  {
    name: 'close then finalize against frozen results',
    pattern:
      /Closure freezes every voter write, so a host facing\s+constant voter edits can always close with the host revision and then finalize/,
    before: 'Closure freezes every voter write',
    after: 'Closure still accepts voter writes',
  },
  {
    name: 'recovery never revokes a credential',
    pattern:
      /Recovery re-delivers that voter's current credential unchanged; it never creates, rotates\s+or revokes a credential/,
    before: 'it never creates, rotates',
    after: 'it rotates',
  },
  {
    name: 'third parties cannot invalidate links through recovery',
    pattern:
      /It never rotates or revokes, so a third party who knows\s+the poll ID and an address can neither invalidate that person's link nor obtain it/,
    before: 'It never rotates or revokes',
    after: 'It rotates eligible credentials',
  },
  {
    name: 'invitation upgrades a public pending enrollee',
    pattern:
      /\| Unexpired public pending enrollee \| Upgraded to an invitation: pending expiry and IP digest cleared/,
    before: 'Upgraded to an invitation: pending expiry',
    after: 'Unchanged: pending expiry',
  },
  {
    name: 'host may re-invite a removed mailbox',
    pattern:
      /\| Removed mailbox \| Re-invited: the host's explicit invitation clears the removal tombstone and reserves a new place/,
    before: "Re-invited: the host's explicit invitation",
    after: "Rejected: the host's explicit invitation",
  },
  {
    name: 'removal deletes voter rows behind counter tombstones',
    pattern:
      /Removal deletes the voter row with its votes, capabilities and deliveries and\s+records `removed_at` on the mailbox counter row/,
    before: 'Removal deletes the voter row',
    after: 'Removal keeps the voter row',
  },
  {
    name: 'resend counters persist across removal and re-invitation',
    pattern: /Persist these counters across removal and re-invitation/,
    before: 'Persist these counters across removal and re-invitation',
    after: 'Persist these counters across expiry/removal/recreation',
  },
  {
    name: 'releases never expose creation before lifecycle',
    pattern:
      /no release may let users create a poll that it cannot also close, cancel,\s+delete, remove voters from and finalize/,
    before: 'no release may let users create a poll that it cannot also close',
    after: 'a release may let users create a poll before it can close',
  },
  {
    name: 'a changed secret fails closed while keyed data exists',
    pattern:
      /If it changes while keyed data exists, the startup check and every voter operation\s+fail closed with `MeetingPollKeyMismatchError`/,
    before: 'every voter operation\nfail closed',
    after: 'every voter operation\nrecords the new secret',
  },
  {
    name: 'a secret is recorded only without keyed data',
    pattern:
      /A secret is recorded only while no keyed data exists, at first use or replacing another\s+one: no voter row and no mailbox counter/,
    before: 'A secret is recorded only while no keyed data exists',
    after: 'A secret is recorded whenever it is configured',
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

const serializedOperations = [
  'enrollment',
  'verification',
  'recovery',
  'invitations',
  'resend',
  'votes',
  'replacements',
  'profile edits',
  'withdrawals',
  'reactivation',
  'reminder opt-out',
  'expiry handling',
  'removal',
  'bulk removal',
  'link rotation',
  'deletion',
  'close',
  'cancel',
  'finalize',
] as const

function verifySerializedOperations(source: string) {
  const list = source.match(/Every poll write serializes on the poll row: ([^.]*)\./)?.[1]
  expect(list, 'serialized operation list').toBeDefined()
  const operations = list?.split(/, | and /).map((operation) => operation.trim()) ?? []
  for (const operation of serializedOperations) {
    expect(operations, `${operation} serializes on the poll row`).toContain(operation)
  }
}

describe('meeting poll design serialized writes', () => {
  it('lists every poll write, including recovery, opt-out and link rotation', () => {
    verifySerializedOperations(document)
  })

  it.each(['recovery', 'reminder opt-out', 'link rotation', 'bulk removal'])(
    'rejects a source-copy omission of %s',
    (operation) => {
      verifySerializedOperations(document)
      const mutated = document.replace(
        /(Every poll write serializes on the poll row: [^.]*)\./,
        (sentence) => sentence.replace(` ${operation},`, ''),
      )
      expect(mutated).not.toBe(document)
      expect(() => verifySerializedOperations(mutated)).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
      verifySerializedOperations(document)
    },
  )
})

function verifyNoInvitationExpiry(source: string) {
  expect(source).not.toMatch(/expired (invitations?|reservations)\b/)
  expect(source).not.toMatch(/counters across expiry/)
}

describe('meeting poll design invitation lifetime wording', () => {
  it('never describes invitations as expiring', () => {
    verifyNoInvitationExpiry(document)
  })

  it.each([
    ['resend cap reason', 'across removal and re-invitation |', 'across expired reservations |'],
    [
      'resend counter persistence',
      'Persist these counters across removal and re-invitation',
      'Persist these counters across expiry/removal/recreation',
    ],
  ])('rejects a source-copy regression of the %s', (_name, before, after) => {
    verifyNoInvitationExpiry(document)
    const mutated = document.replace(before, after)
    expect(mutated).not.toBe(document)
    expect(() => verifyNoInvitationExpiry(mutated)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})

function verifyRotateLinkError(source: string) {
  const rotate = tableRow(source, 'POST `/meeting-polls/{id}/rotate-link`')[3]
  expect(rotate).toContain('otherwise 409 poll_link_unavailable')
  expect(rotate).not.toContain('poll_event_unsupported')
  expect(tableRow(source, '409 `poll_link_unavailable`')[1]).toContain('invited-mode poll')
  const unsupported = tableRow(source, '400 `invalid_poll`')
  expect(unsupported[0]).toContain('`poll_event_unsupported`')
  expect(unsupported[1]).toContain('unsupported group/one-time-link mode')
  expect(source.match(/poll_event_unsupported/g), 'event-mode refusals only').toHaveLength(2)
}

describe('meeting poll design link-rotation refusal', () => {
  it('uses a dedicated code for rotate-link in invited mode', () => {
    verifyRotateLinkError(document)
  })

  it.each([
    ['contract row', 'otherwise 409 poll_link_unavailable', 'otherwise poll_event_unsupported'],
    [
      'error table',
      '| 409 `poll_link_unavailable` | Rotate-link on an invited-mode poll',
      '| 409 `poll_link_unavailable` | Unused',
    ],
    [
      'prose',
      'rejects rotate-link with 409 `poll_link_unavailable`',
      'rejects rotate-link with `poll_event_unsupported`',
    ],
  ])('rejects a source-copy regression of the %s', (_name, before, after) => {
    verifyRotateLinkError(document)
    const mutated = document.replace(before, after)
    expect(mutated).not.toBe(document)
    expect(() => verifyRotateLinkError(mutated)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})

type PublicRateLimits = Record<keyof typeof PUBLIC_RATE_LIMITS, RateLimit>

function verifyRateLimits(source: string, limits: PublicRateLimits) {
  const text = source.replace(/\s+/g, ' ')
  const { page, slots, book, manage } = limits
  const windows = new Set([page, slots, book, manage].map((limit) => limit.windowSeconds))
  expect(windows.size, 'one shared rate-limit window').toBe(1)
  expect(slots.limit, 'page and slots share one documented figure').toBe(page.limit)
  const window = page.windowSeconds
  expect(text).toContain(
    `are per trusted IP per ${window} seconds: page/slots ${page.limit}, book ${book.limit}, manage ${manage.limit}.`,
  )
  expect(text).toContain(
    `new admission bucket sized like \`book\`: ${book.limit} requests per ${window} seconds per trusted IP`,
  )
  expect(text).toContain(`Read uses the page size, ${page.limit}, and`)
  expect(text).toContain(`ballot/withdraw/opt-out the manage size, ${manage.limit}.`)
  expect(text).toContain(
    `40 enrollments in roughly ${Math.ceil(40 / book.limit)} rate-limit windows`,
  )
  expect(text).toContain(`80 admission requests in roughly ${Math.ceil(80 / book.limit)} windows`)
}

describe('meeting poll design public request limits', () => {
  it('matches PUBLIC_RATE_LIMITS in apps/server/src/rate-limit.ts', () => {
    verifyRateLimits(document, PUBLIC_RATE_LIMITS)
  })

  it.each<[string, Partial<PublicRateLimits>]>([
    ['book limit', { book: { limit: 20, windowSeconds: 60 } }],
    ['page limit', { page: { limit: 100, windowSeconds: 60 } }],
    ['slots limit', { slots: { limit: 100, windowSeconds: 60 } }],
    ['manage limit', { manage: { limit: 60, windowSeconds: 60 } }],
    [
      'window',
      {
        page: { limit: 120, windowSeconds: 30 },
        slots: { limit: 120, windowSeconds: 30 },
        book: { limit: 10, windowSeconds: 30 },
        manage: { limit: 30, windowSeconds: 30 },
      },
    ],
  ])('rejects a code-copy change to the %s', (_name, change) => {
    verifyRateLimits(document, PUBLIC_RATE_LIMITS)
    const mutated: PublicRateLimits = { ...PUBLIC_RATE_LIMITS, ...change }
    expect(mutated).not.toEqual(PUBLIC_RATE_LIMITS)
    expect(() => verifyRateLimits(document, mutated)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it.each([
    ['book figure', 'book 10, manage 30', 'book 20, manage 30'],
    ['admission bucket', 'sized like `book`: 10 requests', 'sized like `book`: 20 requests'],
    ['fill arithmetic', 'roughly 4 rate-limit windows', 'roughly 2 rate-limit windows'],
  ])('rejects a source-copy change to the %s', (_name, before, after) => {
    const mutated = document.replace(before, after)
    expect(mutated).not.toBe(document)
    expect(() => verifyRateLimits(mutated, PUBLIC_RATE_LIMITS)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})

function verifyPlan(source: string) {
  const stages = [
    'A1',
    'A2',
    'A3a',
    'A3b',
    'A4a',
    'A4b',
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
  const ownership = (stage: string) => tableRow(source, `${stage} `)[2]
  expect(acceptance('A2')).toContain('on polls without voters')
  expect(acceptance('A2')).toMatch(
    /Voter-dependent results, removal and privacy cascades belong to A4a and A4b/,
  )
  expect(acceptance('A2')).toContain(
    'service-only invariants: immutable event, duration, deadline, admission mode, visibility and settings snapshot/fingerprint; no reopening of closed or canceled polls; public-link polls retain a public token except during deletion',
  )
  expect(acceptance('A2')).toContain(
    'A1 validates candidate duration and start-after-deadline only on slot writes, not parent updates',
  )
  expect(acceptance('A3a')).toContain('Enroll/invite/verify/recover/resend')
  expect(acceptance('A3b')).toContain(
    'Submit/replace full ballots, withdraw/reactivate and opt-out',
  )
  expect(acceptance('A3b')).toContain('transaction waiting across the deadline race')
  expect(acceptance('A4a')).toContain('Results projection, remove voter/bulk remove-unverified')
  expect(acceptance('A4a')).toContain(
    'a voter replacing their ballot every second cannot make close, cancel, rotate-link, remove-voter or remove-unverified fail with `poll_changed`',
  )
  expect(acceptance('A4b')).toContain('privacy-deletion cascades and deletion races')
  expect(acceptance('A4b')).toContain(
    'a voter replacing their ballot every second cannot make delete fail with `poll_changed`',
  )
  expect(acceptance('B2')).toMatch(
    /CLI secrets must be read from stdin from this first step, never argv/,
  )
  expect(acceptance('B1')).toContain(
    'Workers take `ensureMeetingPollKey` first in each transaction, before any row lock or claim',
  )
  expect(acceptance('B4')).toContain(
    'Jobs that open or mint a credential take `ensureMeetingPollKey` first in each transaction',
  )
  expect(acceptance('B2')).toContain(
    'call `ensureMeetingPollKey` at server start, before any meeting-poll route serves',
  )
  expect(acceptance('B2')).toContain('every public operation refused under a mismatched key')
  expect(acceptance('C2b')).toContain(
    'finalize while open with a stale results revision returns `poll_changed`',
  )
  expect(acceptance('C2b')).toContain(
    'finalize after close succeeds even when a voter edited every second until closure',
  )
  expect(ownership('D1')).toBe(
    'Host list/read/results/close/cancel/delete/finalize REST, MCP and CLI together',
  )
  expect(ownership('D2')).toBe(
    'Host create/invite/resend/remove/remove-unverified/rotate-link REST, MCP and CLI together',
  )
  expect(acceptance('D4a')).toContain('conditional acknowledgment/finalize, close/cancel/delete')
  expect(acceptance('D4a')).toContain(
    'Switches the B4 deadline-mail results link from the D1 REST endpoint to this page',
  )
  expect(acceptance('D4b')).toContain('Personal/team creation')
  expect(acceptance('D4b')).toContain('invitation roster with invite/resend/remove')
}

describe('meeting poll day-sized implementation plan', () => {
  it('orders split steps, ownership and flags with secure CLI input from introduction', () => {
    verifyPlan(document)
  })

  it.each([
    [
      'service-owned invariants',
      'service-only invariants: immutable event',
      'database invariants: immutable event',
    ],
    [
      'slot-only enforcement',
      'only on slot writes, not parent updates',
      'on slot writes and parent updates',
    ],
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
    ['cleanup split', '| A4b Storage', '| A4 Storage'],
    [
      'voter churn cannot block host writes',
      'a voter replacing their ballot every second cannot make close',
      'host writes may fail while a voter edits close',
    ],
    [
      'delete under voter churn',
      'cannot make delete fail with `poll_changed`',
      'may make delete fail with `poll_changed`',
    ],
    [
      'stale results revision on finalize',
      'finalize while open with a stale results revision returns `poll_changed`',
      'finalize while open ignores the results revision',
    ],
    [
      'finalize after close',
      'finalize after close succeeds even when a voter edited every second until closure',
      'finalize after close may fail',
    ],
    [
      'lifecycle before creation transports',
      'Host list/read/results/close/cancel/delete/finalize REST',
      'Host create/list/read/results/invite REST',
    ],
    [
      'creation ships with roster remedies',
      'Host create/invite/resend/remove/remove-unverified/rotate-link REST',
      'Host create/invite REST',
    ],
    [
      'worker key fence',
      'Workers take `ensureMeetingPollKey` first in each transaction, before any row lock',
      'Workers take `ensureMeetingPollKey` in each transaction, after their claims',
    ],
    [
      'reminder job key fence',
      'Jobs that open or mint a credential take `ensureMeetingPollKey` first',
      'Jobs that open or mint a credential',
    ],
    [
      'startup key fence',
      'call `ensureMeetingPollKey` at server start',
      'derive the meeting-poll keys at server start',
    ],
    [
      'mismatched key refusal tests',
      'every public operation refused under a mismatched key',
      'rotation of the secret',
    ],
    [
      'deadline mail switch',
      'Switches the B4 deadline-mail results link from the D1 REST endpoint to this page',
      'Keeps the REST link',
    ],
  ])('rejects a source-copy regression of %s', (_name, before, after) => {
    verifyPlan(document)
    const mutated = document.replace(before, after)
    expect(mutated).not.toBe(document)
    expect(() => verifyPlan(mutated)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    verifyPlan(document)
  })
})

const contractRevisions = [
  ['POST `/meeting-polls`', []],
  ['GET `/meeting-polls`, GET `/meeting-polls/{id}`', []],
  ['GET `/meeting-polls/{id}/results`', []],
  ['POST `/meeting-polls/{id}/invitations`', []],
  ['POST `/meeting-polls/{id}/invitations/{voterId}/resend`', ['expectedHostRevision']],
  ['DELETE `/meeting-polls/{id}/voters/{voterId}`', ['expectedHostRevision']],
  ['POST `/meeting-polls/{id}/remove-unverified`', ['expectedHostRevision']],
  ['DELETE `/meeting-polls/{id}`', ['expectedHostRevision']],
  ['POST `/meeting-polls/{id}/close`, `/cancel`', ['expectedHostRevision']],
  ['POST `/meeting-polls/{id}/finalize`', ['expectedResultsRevision']],
  ['POST `/meeting-polls/{id}/rotate-link`', ['expectedHostRevision']],
  ['POST `/public/meeting-polls/read`', []],
  ['POST `/public/meeting-polls/enroll`, `/recover`', []],
  ['POST `/public/meeting-polls/verify`', []],
  ['POST `/public/meeting-polls/vote`', ['expectedBallotRevision']],
  ['POST `/public/meeting-polls/reminder-opt-out`', []],
  ['POST `/public/meeting-polls/withdraw`', ['expectedBallotRevision']],
] as const

function verifyRevisionContract(source: string) {
  const text = source.replace(/\s+/g, ' ')
  expect(text).toContain(
    '`host_revision` changes only on accepted host writes (invitation, resend, removal, bulk removal, link rotation) and host lifecycle transitions (close, cancel, finalize); voter actions, recovery, reminder opt-out, public pending expiry and the derived deadline transition never change it.',
  )
  expect(text).toContain(
    '`results_revision` changes whenever the results/attendee snapshot changes: admission, verification, ballot and profile edits, withdrawal, reactivation, invitation, removal and bulk removal. Only finalize checks it, through `expectedResultsRevision`',
  )
  expect(text).toContain(
    'Bulk removal retains mailbox tombstones/counters and uses the same poll lock and `expectedHostRevision`, so voter activity cannot make any of these remedies fail.',
  )
  expect(text).toContain(
    'These operations use current authority, `expectedHostRevision` and the common poll lock',
  )
  expect(source).not.toMatch(/\bexpectedRevision\b/)
  for (const [resource, revisions] of contractRevisions) {
    expect(
      tableRow(source, resource)[3]?.match(/\bexpected\w*Revision\b/g) ?? [],
      resource,
    ).toEqual(revisions)
  }
}

describe('meeting poll exact revision contract', () => {
  it('pins both bump lists, bulk removal and every contract row revision field', () => {
    verifyRevisionContract(document)
  })

  it.each([
    [
      'host bump list',
      'removal, link rotation) and host lifecycle',
      'removal, link rotation, ballot edits) and host lifecycle',
    ],
    [
      'host lifecycle bump list',
      '(close, cancel, finalize); voter',
      '(close, cancel, finalize, verification); voter',
    ],
    [
      'results bump list',
      'bulk removal. Only finalize checks it',
      'bulk removal, recovery. Only finalize checks it',
    ],
    [
      'bulk-removal prose',
      '`expectedHostRevision`, so voter activity',
      '`expectedResultsRevision`, so voter activity',
    ],
    [
      'lifecycle authority sentence',
      'These operations use current authority, `expectedHostRevision`',
      'These operations use current authority, `expectedResultsRevision`',
    ],
    ['legacy revision field', 'Require `expectedBallotRevision`', 'Require `expectedRevision`'],
  ])('rejects a source-copy regression of %s', (_name, before, after) => {
    verifyRevisionContract(document)
    const mutated = document.replace(before, after)
    expect(mutated).not.toBe(document)
    expect(() => verifyRevisionContract(mutated)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    verifyRevisionContract(document)
  })

  it.each(contractRevisions)(
    'rejects a source-copy revision change in %s',
    (resource, revisions) => {
      verifyRevisionContract(document)
      const original = document.split('\n').find((line) => line.startsWith(`| ${resource} |`))
      expect(original).toBeDefined()
      const replacement = revisions.length
        ? original?.replace(
            revisions[0],
            revisions[0] === 'expectedHostRevision'
              ? 'expectedResultsRevision'
              : 'expectedHostRevision',
          )
        : original?.replace(/ \|$/, '; expectedHostRevision |')
      const mutated = document.replace(original ?? '', replacement ?? '')
      expect(mutated).not.toBe(document)
      expect(() => verifyRevisionContract(mutated)).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
      verifyRevisionContract(document)
    },
  )
})

const invitationOutcomes = [
  [
    'Active host invitee, verified or not',
    'Unchanged: no new place, credential or mail; lost mail uses resend',
  ],
  ['Verified public-link voter', 'Unchanged: keeps its place, credential and ballot; no mail'],
  [
    'Unexpired public pending enrollee',
    'Upgraded to an invitation: pending expiry and IP digest cleared, verification credential revoked, invitation mail with a voting credential; still one place',
  ],
  [
    'Withdrawn voter',
    "Unchanged: withdrawal opted out of poll mail; only the voter's own capability can reactivate. A host who removes and then re-invites the address overrides this deliberately and sends one invitation; a reminder opt-out still applies",
  ],
  [
    'Expired public pending enrollee',
    'Invited as new: the expired row is replaced and a new place is reserved',
  ],
  [
    'Removed mailbox',
    "Re-invited: the host's explicit invitation clears the removal tombstone and reserves a new place; mailbox counters persist",
  ],
] as const

function verifyInvitationOutcomes(source: string) {
  for (const [state, outcome] of invitationOutcomes) {
    expect(tableRow(source, `${state} |`)[1], state).toBe(outcome)
  }
}

describe('meeting poll invitation outcome contract', () => {
  it('pins the complete outcome of each of the six mailbox states', () => {
    verifyInvitationOutcomes(document)
  })

  it.each(invitationOutcomes)('rejects a source-copy outcome change for %s', (state, outcome) => {
    verifyInvitationOutcomes(document)
    const mutated = document.replace(`| ${state} | ${outcome} |`, `| ${state} | Re-invited |`)
    expect(mutated).not.toBe(document)
    expect(() => verifyInvitationOutcomes(mutated)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    verifyInvitationOutcomes(document)
  })
})

const migration = readFileSync(
  new URL('../packages/db/migrations/0071_meeting_polls.sql', import.meta.url),
  'utf8',
)

/** Exactly one whole-token occurrence: `AND 3)` must not match a widened `AND 30)`. */
function expectExactFragment(sql: string, fragment: string) {
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  expect(
    sql.match(new RegExp(`(?<![\\w'])${escaped}(?![\\w'])`, 'g')) ?? [],
    fragment,
  ).toHaveLength(1)
}

function verifyStoragePolicy(sql: string, docs: string) {
  const limits = MEETING_POLL_LIMITS
  const retention = MEETING_POLL_RETENTION
  const rows = [
    ['Candidates per poll', `${limits.minCandidates}–${limits.maxCandidates}`],
    ['Enrollments per poll', `0–${limits.maxEnrollments}`],
    ['Attendees per booking', `${limits.minAttendees}–${limits.maxAttendees}`],
    ['Pending enrollment expiry', `${limits.pendingExpirySeconds / 3600} hour`],
    ['Public pending reservations per IP/poll', `${limits.maxPendingPerIp}`],
    [
      'Deadline after creation',
      `${limits.minDeadlineSeconds / 3600} hour–${limits.maxDeadlineSeconds / 86400} days`,
    ],
    ['Reminder lead time', `${limits.reminderLeadSeconds / 3600} hours`],
    ['Invitation resend cooldown', `${limits.resendCooldownSeconds / 60} minutes`],
    ['Invitation resend cap', `${limits.maxResendsPerMailbox} per poll/mailbox`],
    ['Recovery delivery cooldown', `${limits.recoveryCooldownSeconds / 60} minutes`],
    ['Recovery delivery cap', `${limits.maxRecoveriesPerCredential} per mailbox credential`],
  ] as const
  for (const [label, value] of rows) verifyLimit(docs, label, value)
  for (const fragment of [
    `position BETWEEN 0 AND ${limits.maxCandidates - 1}`,
    `total NOT BETWEEN ${limits.minCandidates} AND ${limits.maxCandidates}`,
    `IF total>=${limits.maxEnrollments} THEN`,
    `IF total>=${limits.maxPendingPerIp} THEN`,
    `deadline_at BETWEEN created_at+interval '${limits.minDeadlineSeconds / 3600} hour' AND created_at+interval '${limits.maxDeadlineSeconds / 3600} hours'`,
    `pending_expires_at<=created_at+interval '${limits.pendingExpirySeconds / 3600} hour'`,
    `resend_count BETWEEN 0 AND ${limits.maxResendsPerMailbox}`,
    `recovery_count BETWEEN 0 AND ${limits.maxRecoveriesPerCredential}`,
    `attempts BETWEEN 0 AND ${retention.deliveryMaxAttempts}`,
    `purge_at=clock_timestamp()+interval '${retention.deletedReceiptDays} days'`,
  ])
    expectExactFragment(sql, fragment)
  const text = docs.replace(/\s+/g, ' ')
  expect(retention.sweepSeconds).toBe(3600)
  expect(text).toContain(`run hourly, in batches of at most ${retention.batchSize} rows`)
  expect(text).toContain(`replay digests for ${retention.deletedReceiptDays} days from deletion`)
  expect(text).toContain(
    `at most ${retention.deliveryMaxAttempts} attempts with a ${retention.deliveryLeaseSeconds / 60}-minute lease`,
  )
  expect(limits.admissionRequestsPerWindow).toBe(PUBLIC_RATE_LIMITS.book.limit)
  expect(limits.readRequestsPerWindow).toBe(PUBLIC_RATE_LIMITS.page.limit)
  expect(limits.ballotRequestsPerWindow).toBe(PUBLIC_RATE_LIMITS.manage.limit)
  for (const bucket of ['book', 'page', 'manage'] as const) {
    expect(limits.requestWindowSeconds).toBe(PUBLIC_RATE_LIMITS[bucket].windowSeconds)
  }
  verifyRateLimits(docs, PUBLIC_RATE_LIMITS)
}

describe('meeting poll shared SQL, TypeScript and documentation policy', () => {
  it('binds storage limits, cleanup bounds and public request buckets to the shared constants', () => {
    verifyStoragePolicy(migration, document)
  })

  it.each([
    ['candidate position', 'position BETWEEN 0 AND 19', 'position BETWEEN 0 AND 24'],
    ['candidate count', 'total NOT BETWEEN 2 AND 20', 'total NOT BETWEEN 2 AND 25'],
    ['enrollments', 'IF total>=40 THEN', 'IF total>=41 THEN'],
    ['pending IP cap', 'IF total>=3 THEN', 'IF total>=4 THEN'],
    ['deadline minimum', "created_at+interval '1 hour' AND", "created_at+interval '1 minute' AND"],
    ['deadline maximum', "interval '720 hours'", "interval '744 hours'"],
    [
      'pending expiry',
      "pending_expires_at<=created_at+interval '1 hour'",
      "pending_expires_at<=created_at+interval '2 hours'",
    ],
    ['resends', 'resend_count BETWEEN 0 AND 3', 'resend_count BETWEEN 0 AND 4'],
    ['recovery', 'recovery_count BETWEEN 0 AND 3', 'recovery_count BETWEEN 0 AND 4'],
    ['attempts', 'attempts BETWEEN 0 AND 5', 'attempts BETWEEN 0 AND 6'],
    ['receipt retention', "interval '90 days'", "interval '91 days'"],
    [
      'appended candidate position digit',
      'position BETWEEN 0 AND 19)',
      'position BETWEEN 0 AND 199)',
    ],
    [
      'appended candidate count digit',
      'total NOT BETWEEN 2 AND 20 THEN',
      'total NOT BETWEEN 2 AND 200 THEN',
    ],
    ['appended enrollment digit', 'IF total>=40 THEN', 'IF total>=400 THEN'],
    ['appended pending IP digit', 'IF total>=3 THEN', 'IF total>=30 THEN'],
    ['appended resend digit', 'resend_count BETWEEN 0 AND 3)', 'resend_count BETWEEN 0 AND 30)'],
    [
      'appended recovery digit',
      'recovery_count BETWEEN 0 AND 3)',
      'recovery_count BETWEEN 0 AND 30)',
    ],
    ['appended attempts digit', 'attempts BETWEEN 0 AND 5)', 'attempts BETWEEN 0 AND 50)'],
    [
      'duplicated pending IP cap',
      'IF total>=3 THEN',
      'IF total>=3 THEN NULL; END IF; IF total>=3 THEN',
    ],
  ])('rejects a SQL source-copy change to %s', (_name, before, after) => {
    const mutated = migration.replace(before, after)
    expect(mutated).not.toBe(migration)
    expect(() => verifyStoragePolicy(mutated, document)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it.each([
    ['sweep cadence', 'run hourly, in batches', 'run daily, in batches'],
    ['batch size', 'at most 500 rows', 'at most 501 rows'],
    ['receipt retention', 'digests for 90 days from deletion', 'digests for 91 days from deletion'],
    ['attempt cap', 'at most 5 attempts', 'at most 6 attempts'],
    ['lease duration', 'with a 5-minute lease', 'with a 6-minute lease'],
  ])('rejects a cleanup documentation source-copy change to %s', (_name, before, after) => {
    const mutated = document.replace(before, after)
    expect(mutated).not.toBe(document)
    expect(() => verifyStoragePolicy(migration, mutated)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})

const receiptColumns =
  'nullable `booking_id` (set by finalize; a receipt stores no result beyond its `poll_id` and `booking_id` references). Replays return only those stored references: a create replay returns `poll_id` as `poll_already_created`, a finalize replay returns the booking reference, and invite, resend and rotate-link replays return their safe outcome or conflict without a stored result'
const receiptCleanup =
  'On poll deletion erase poll/booking references (`poll_id` and `booking_id`);'

function verifyReceiptWording(design: string, model: string) {
  expect(tableRow(design, '`meeting_poll_operations`')[1]).toContain(receiptColumns)
  expect(tableRow(design, 'Operation receipts')[1]).toContain(receiptCleanup)
  expect(model.replace(/\s+/g, ' ')).toContain(
    'Operation receipts lose poll/booking references (`poll_id` and `booking_id`) on poll deletion',
  )
  // 0071 stores no result metadata column; a create replay returns poll_id, finalize booking_id.
  for (const source of [design, model]) expect(source).not.toMatch(/result metadata/i)
}

describe('meeting poll operation receipt columns', () => {
  it('names the stored result reference and the references erased on deletion', () => {
    verifyReceiptWording(document, dataModel)
  })

  it.each([
    ['design columns', receiptColumns, 'nullable `booking_id`, minimal result metadata', 'design'],
    [
      'design replay wording',
      receiptColumns,
      'nullable `booking_id` (the only stored replay result reference)',
      'design',
    ],
    [
      'design stored-result wording',
      receiptColumns,
      receiptColumns.replace(
        'stores no result beyond its `poll_id` and `booking_id` references',
        'stores no other result',
      ),
      'design',
    ],
    [
      'design cleanup',
      receiptCleanup,
      'On poll deletion erase poll/booking references and result metadata;',
      'design',
    ],
    [
      'data model cleanup',
      'lose poll/booking references (`poll_id` and `booking_id`)',
      'lose poll/booking references and result metadata',
      'model',
    ],
  ])('rejects a source-copy revert of the %s', (_name, before, after, file) => {
    const design = file === 'design' ? document.replace(before, after) : document
    const model = file === 'model' ? dataModel.replace(before, after) : dataModel
    expect([design, model]).not.toEqual([document, dataModel])
    expect(() => verifyReceiptWording(design, model)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
