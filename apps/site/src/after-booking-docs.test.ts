import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUCCESS_REDIRECT_MAX_LENGTH, SUCCESS_REDIRECT_PARAMETERS } from '@hourmere/scheduling'
import { describe, expect, it } from 'vitest'
import { validateSuccessRedirect } from '../../../packages/scheduling/src/success-redirect.ts'
import { HELP } from '../../../tools/cli/src/cli.ts'
import { SUCCESS_REDIRECT_ERROR_FIELDS } from '../../server/src/success-redirect-errors.ts'

const root = process.env.HOURMERE_DOCS_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const siteDocs = 'apps/site/src/content/docs/docs'
const guide = () => read(`${siteDocs}/after-booking.md`)
const prose = (source: string) => source.replace(/[*`]/g, '').replace(/\s+/g, ' ')

function assertUrlPolicy(source: string) {
  const text = prose(source)
  for (const constraint of [
    'absolute HTTPS URL',
    `${SUCCESS_REDIRECT_MAX_LENGTH} characters before and after normalization`,
    'no username/password, whitespace, control characters or malformed Unicode',
    'HTTP is refused even for local development targets',
    'IP addresses',
    'localhost, .localhost and single-label hosts',
    'SUCCESS_REDIRECT_ALLOW_IP_HOSTS=true',
    "instance's own PUBLIC_URL host is also allowed",
    'Both exceptions still require HTTPS',
    'Hourmere never makes a server-side request to the target',
  ])
    expect(text).toContain(constraint)
}

function assertParameters(source: string) {
  const table = source.split('The complete parameter whitelist is:')[1]?.split('## REST')[0] ?? ''
  const names = [...table.matchAll(/^\| `([^`]+)` \|/gm)].map(([, name]) => name)
  expect(names).toEqual([...SUCCESS_REDIRECT_PARAMETERS])
  const text = prose(table)
  expect(text).toContain('default parameter list is empty')
  expect(text).toContain('Names must be distinct')
  expect(text).toContain(
    'Answers, guests, phone numbers, manage/reschedule tokens and internal identifiers are never added',
  )
  expect(text).toContain('inviteeName=Ada+%26+Co')
  expect(text).toContain('Existing query text and fragments are preserved')
  expect(text).toContain('both values remain')
}

function assertConsent(source: string) {
  const text = prose(source)
  for (const statement of [
    'Read the privacy warning before enabling invitee name/email',
    'selected invitee names and emails become visible to the target website and its analytics',
    'can appear in browser history',
    'personal-data permission starts off',
    'Enabling it alone adds neither value',
    'Separately enable parent navigation',
    'preview uses sample values',
    "editor sends redirect settings only when they differ from the editor session's baseline",
  ])
    expect(text).toContain(statement)
}

function assertWriteContract(source: string) {
  const text = prose(source)
  for (const statement of [
    'read and bookings keys cannot change this setting',
    'PATCH /api/v1/event-types/{id} replaces the complete redirect object when supplied',
    'Omitting successRedirect preserves the saved setting',
    'Inside a replacement object, omitted parameters defaults to [], and both permissions default to false',
    'create_event_type and update_event_type accept the same successRedirect object or null as REST',
    'Conflicting values are refused before a request',
  ])
    expect(text.toLowerCase()).toContain(statement.toLowerCase())
  for (const field of SUCCESS_REDIRECT_ERROR_FIELDS) expect(source).toContain(`\`${field}\``)
}

function assertEmbedContract(source: string) {
  const text = prose(source)
  for (const statement of [
    'There is no automatic navigation or countdown',
    'new tab with rel="noopener noreferrer"',
    'starts with a restrictive iframe sandbox',
    'confirms the saved parent-navigation opt-in',
    'reload before allowing input',
    'capability for any user-activated top navigation in the frame',
    'rather than a browser restriction to the configured Continue URL',
    'falls back after five seconds to the restrictive sandbox',
    'older widget without the permission marker',
    'Manual iframes need matching sandbox permission',
    'completion message includes no redirect URL, booking details or personal data',
  ])
    expect(text).toContain(statement)
}

function assertPolicyChanges(source: string) {
  const text = prose(source)
  for (const statement of [
    'API/MCP/CLI bookings, one-time booking links, management reads, rescheduling and cancellation do not',
    'invitees cannot supply one in the booking request',
    'retains its original destination snapshot',
    'Booking still succeeds with normal confirmation and no continuation',
    'Unrelated event-type edits still work and preserve that saved setting',
    'even unchanged, must pass the current policy',
    'Restoring a policy cannot add a continuation',
    'contains no target URL or invitee data',
  ])
    expect(text).toContain(statement)
}

describe('after-booking redirect documentation', () => {
  it('keeps the URL rules aligned with the shared service contract', () => assertUrlPolicy(guide()))
  it('publishes exactly the service whitelist with encoding and duplicate-query semantics', () =>
    assertParameters(guide()))
  it('puts the privacy warning before opting in and explains baseline-only redirect updates', () =>
    assertConsent(guide()))
  it('explains scoped replacement writes, MCP parity and stable field errors', () =>
    assertWriteContract(guide()))
  it('explains the restrictive sandbox and the user-activated capability ceiling', () =>
    assertEmbedContract(guide()))
  it('preserves booking and unrelated-edit behavior after operator policy changes', () =>
    assertPolicyChanges(guide()))
  it('validates both saved-configuration JSON examples through the shared service', () => {
    const examples = [...guide().matchAll(/```json\n([\s\S]*?)\n```/g)]
    expect(examples).toHaveLength(2)
    for (const [, example] of examples) {
      const { successRedirect } = JSON.parse(example ?? '')
      expect(validateSuccessRedirect(successRedirect)).toEqual(successRedirect)
    }
  })
  it('keeps every documented CLI flag in actual help and keeps the clear switch valueless', () => {
    const source = guide()
    const flags = [...source.matchAll(/^\| `(--[^`]+)` \|/gm)].map(([, flag]) => flag ?? '')
    expect(flags).toHaveLength(5)
    for (const flag of flags) expect(HELP).toContain(flag)
    expect(source).toContain('Switch without a value')
    expect(source).toContain('cannot be combined with redirect')
  })
  it('links the guide from editor/API/CLI discovery and retains a canonical repository pointer', () => {
    expect(read('apps/site/astro.config.ts')).toContain("link: '/docs/after-booking'")
    for (const page of ['index', 'rest', 'mcp', 'cli', 'embedding']) {
      expect(read(`${siteDocs}/${page}.md`)).toMatch(/\]\(\/docs\/after-booking(?:#[a-z-]+)?\)/)
    }
    for (const path of [
      'docs/after-booking.md',
      'docs/data-model.md',
      'docs/mcp.md',
      'tools/cli/README.md',
    ]) {
      expect(read(path)).toContain('](https://hourmere.com/docs/after-booking)')
    }
    for (const [, target] of guide().matchAll(/\]\((\/docs\/[^)]+)\)/g)) {
      const [path] = (target ?? '').slice('/docs/'.length).split('#')
      expect(existsSync(join(root, siteDocs, `${path}.md`)), target).toBe(true)
    }
  })
  it.each<[string, string, (source: string) => void]>([
    ['Both exceptions still require HTTPS', 'Exceptions permit HTTP', assertUrlPolicy],
    [
      'SUCCESS_REDIRECT_ALLOW_IP_HOSTS=true',
      'SUCCESS_REDIRECT_ALLOW_IP_HOSTS=false',
      assertUrlPolicy,
    ],
    ['| `inviteeEmail` |', '| `phone` |', assertParameters],
    ['inviteeName=Ada+%26+Co', 'inviteeName=Ada & Co', assertParameters],
    [
      'Answers, guests, phone numbers, manage/reschedule tokens and internal identifiers\nare never added',
      'All booking fields are added',
      assertParameters,
    ],
    [
      'Read the privacy warning before enabling invitee name/email',
      'Enable personal data',
      assertConsent,
    ],
    ['personal-data permission starts off', 'personal-data permission starts on', assertConsent],
    [
      'editor sends redirect settings only when they differ',
      'editor always sends redirect settings',
      assertConsent,
    ],
    [
      'replaces the complete redirect object when supplied',
      'merges each supplied redirect field',
      assertWriteContract,
    ],
    [
      '`read` and `bookings` keys cannot change this setting',
      'all keys can change this setting',
      assertWriteContract,
    ],
    [
      'starts with a restrictive iframe\nsandbox',
      'always allows parent navigation',
      assertEmbedContract,
    ],
    [
      'capability for any user-activated top\nnavigation in the frame',
      'capability restricted to the Continue URL',
      assertEmbedContract,
    ],
    [
      'Booking still succeeds with normal confirmation and no continuation',
      'Booking fails',
      assertPolicyChanges,
    ],
    [
      'Unrelated event-type edits still work and preserve that saved setting',
      'All event-type edits fail',
      assertPolicyChanges,
    ],
    [
      'even unchanged, must pass the current policy',
      'can keep the old policy',
      assertPolicyChanges,
    ],
  ])('rejects a changed source copy of the contract: %s', (before, after, verify) => {
    const source = guide()
    expect(source).toContain(before)
    expect(() => verify(source.replace(before, after))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
