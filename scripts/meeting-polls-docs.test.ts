import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PUBLIC_RATE_LIMITS, type RateLimit } from '../apps/server/src/rate-limit.ts'
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
