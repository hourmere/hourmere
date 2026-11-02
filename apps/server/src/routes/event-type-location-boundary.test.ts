import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import { EventType, EventTypeInput, EventTypeUpdate } from './event-types.ts'

function responseCopy(removeGuard = false) {
  const source = readFileSync('apps/server/src/routes/event-types.ts', 'utf8')
  const start = source.indexOf('const eventTypeResponse = ')
  const end = source.indexOf('\nconst locationKinds = ', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  let copy = source.slice(start, end)
  if (removeGuard) {
    expect(copy).toContain('  locations: _locations,\n')
    copy = copy.replace('  locations: _locations,\n', '')
  }
  return new Function(`${stripTypeScriptTypes(copy)}; return eventTypeResponse`)() as (
    input: Record<string, unknown>,
  ) => Record<string, unknown>
}

const settings = {
  location: { kind: 'phone', number: '+14155550123' },
  locations: [
    { id: 'phone', kind: 'phone', number: '+14155550123' },
    { id: 'office', kind: 'in_person', address: 'Saved address' },
  ],
  successRedirect: { url: 'https://example.com/complete' },
}

function verifyProjection(project: ReturnType<typeof responseCopy>) {
  const response = project({ id: 'event', ...settings })
  expect(response).toEqual({ id: 'event', location: settings.location })
  expect(response).not.toHaveProperty('locations')
}

function editorCopy(removeGuard = false) {
  const source = readFileSync('apps/web/src/pages/event-types/event-type-form.ts', 'utf8')
  const start = source.indexOf('export function draftFromEventType(')
  const end = source.indexOf('/** What decides whether', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  let copy = source.slice(start, end)
  if (removeGuard) {
    expect(copy).toContain(" && 'number' in location")
    copy = copy.replace(" && 'number' in location", '')
  }
  return new Function(
    'text',
    'notificationsFromSettings',
    `${stripTypeScriptTypes(copy).replace('export ', '')}; return draftFromEventType`,
  )(
    (value: unknown) => String(value ?? ''),
    () => ({}),
  ) as (input: Record<string, unknown>) => { phone: string }
}

function verifyEditor(project: ReturnType<typeof editorCopy>) {
  const draft = project({
    location: { kind: 'phone', askInvitee: true },
    allowedDurationsMinutes: [30],
    questions: [],
  })
  expect(draft.phone).toBe('')
}

describe('internal event location options boundary', () => {
  it('retains the existing REST response while the multi-option surfaces are deferred', () => {
    verifyProjection(responseCopy())
  })

  it('detects a source-copy mutation exposing the internal option list', () => {
    expect(() => verifyProjection(responseCopy(true))).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    verifyProjection(responseCopy())
  })

  it('rejects option writes through the shared REST and MCP schemas', () => {
    expect(
      EventTypeInput.safeParse({
        slug: 'call',
        title: 'Call',
        durationMinutes: 30,
        locations: settings.locations,
      }).success,
    ).toBe(false)
    expect(EventTypeUpdate.safeParse({ locations: settings.locations }).success).toBe(false)
  })

  it('leaves options out of the shared MCP output schema', () => {
    expect(EventType.shape).not.toHaveProperty('locations')
  })

  it('reads the invitee-phone compatibility setting without enabling legacy phone writes', () => {
    const location = { kind: 'phone', askInvitee: true }
    expect(EventType.shape.location.parse(location)).toEqual(location)
    expect(
      EventTypeInput.safeParse({ slug: 'call', title: 'Call', durationMinutes: 30, location })
        .success,
    ).toBe(false)
    expect(EventTypeUpdate.safeParse({ location }).success).toBe(false)
  })

  it('detects losing the legacy editor phone-read guard', () => {
    verifyEditor(editorCopy())
    expect(() => verifyEditor(editorCopy(true))).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    verifyEditor(editorCopy())
  })
})
