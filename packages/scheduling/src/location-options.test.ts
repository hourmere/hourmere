import { describe, expect, it } from 'vitest'
import {
  applyLegacyLocation,
  compatLocation,
  type EventTypeLocation,
  type LocationChoiceContext,
  type LocationOption,
  locationOptionsFromLegacy,
  publicLocationOptions,
  resolveLocationChoice,
  validateLocationOptions,
} from './location-options.ts'

const context: LocationChoiceContext = {
  schedulingType: 'individual',
  hostUserIds: ['host'],
  meetReadyHostUserIds: ['host'],
  zoomReadyHostUserIds: ['host'],
}

const allKinds: LocationOption[] = [
  { id: 'meet', kind: 'google_meet', autoCreate: true },
  { id: 'zoom', kind: 'zoom', autoCreate: true },
  { id: 'phone', kind: 'phone', number: '+14155550123' },
  { id: 'office', kind: 'in_person', address: '1 Main Street' },
  { id: 'link', kind: 'link', url: 'https://example.com/room' },
]

describe('location options validation', () => {
  it('preserves ordered kinds and normalizes text/URLs without mutating the input', () => {
    const input = [
      { id: 'Office_1', kind: 'in_person', address: ' 1 Main Street ', label: ' Office ' },
      { id: 'web', kind: 'link', url: ' https://EXAMPLE.COM:443/room ', isDefault: true },
    ]
    expect(validateLocationOptions(input)).toEqual([
      { id: 'Office_1', kind: 'in_person', address: '1 Main Street', label: 'Office' },
      { id: 'web', kind: 'link', url: 'https://example.com/room', isDefault: true },
    ])
    expect(input[0]?.label).toBe(' Office ')
    expect(validateLocationOptions(allKinds)).toEqual(allKinds)
    expect(validateLocationOptions(null)).toBeNull()
  })

  it('accepts both phone modes and passive conference settings', () => {
    expect(validateLocationOptions([{ id: 'phone', kind: 'phone', askInvitee: true }])).toEqual([
      { id: 'phone', kind: 'phone', askInvitee: true },
    ])
    expect(
      validateLocationOptions([
        { id: 'meet', kind: 'google_meet' },
        { id: 'zoom', kind: 'zoom' },
      ]),
    ).toEqual([
      { id: 'meet', kind: 'google_meet' },
      { id: 'zoom', kind: 'zoom' },
    ])
    expect(validateLocationOptions([{ id: 'x', kind: 'link', url: 'http://example.com' }])).toEqual(
      [{ id: 'x', kind: 'link', url: 'http://example.com/' }],
    )
  })

  it('accepts boundary lengths and E.164 digit counts', () => {
    expect(
      validateLocationOptions([
        { id: 'x'.repeat(64), kind: 'in_person', label: 'x'.repeat(100), address: 'x'.repeat(500) },
        { id: 'phone', kind: 'phone', number: '+1234567' },
        { id: 'link', kind: 'link', url: `https://example.com/${'x'.repeat(1980)}` },
      ]),
    ).toHaveLength(3)
    expect(
      validateLocationOptions([{ id: 'x', kind: 'phone', number: '+123456789012345' }]),
    ).toHaveLength(1)
  })

  it.each([
    ['undefined list', undefined],
    ['object list', {}],
    ['empty list', []],
    ['sparse list', new Array(1)],
    ['too many options', [...allKinds, { id: 'extra', kind: 'link', url: 'https://example.com' }]],
    ['null option', [null]],
    ['array option', [[]]],
    ['missing id', [{ kind: 'zoom' }]],
    ['empty id', [{ id: '', kind: 'zoom' }]],
    ['long id', [{ id: 'x'.repeat(65), kind: 'zoom' }]],
    ['invalid id', [{ id: 'a b', kind: 'zoom' }]],
    ['reserved id', [{ id: '__proto__', kind: 'zoom' }]],
    [
      'duplicate ids',
      [
        { id: 'x', kind: 'zoom' },
        { id: 'x', kind: 'google_meet' },
      ],
    ],
    [
      'duplicate kinds',
      [
        { id: 'x', kind: 'zoom' },
        { id: 'y', kind: 'zoom' },
      ],
    ],
    ['unknown kind', [{ id: 'x', kind: 'teams' }]],
    ['missing kind', [{ id: 'x' }]],
    ['unknown setting', [{ id: 'x', kind: 'zoom', url: 'https://example.com' }]],
    ['empty label', [{ id: 'x', kind: 'zoom', label: ' ' }]],
    ['long label', [{ id: 'x', kind: 'zoom', label: 'x'.repeat(101) }]],
    ['non-string label', [{ id: 'x', kind: 'zoom', label: 1 }]],
    ['false default', [{ id: 'x', kind: 'zoom', isDefault: false }]],
    [
      'two defaults',
      [
        { id: 'x', kind: 'zoom', isDefault: true },
        { id: 'y', kind: 'google_meet', isDefault: true },
      ],
    ],
    ['false autoCreate', [{ id: 'x', kind: 'google_meet', autoCreate: false }]],
    ['string autoCreate', [{ id: 'x', kind: 'zoom', autoCreate: 'true' }]],
    ['missing phone mode', [{ id: 'x', kind: 'phone' }]],
    ['invalid host phone', [{ id: 'x', kind: 'phone', number: '4155550123' }]],
    ['short host phone', [{ id: 'x', kind: 'phone', number: '+123456' }]],
    ['long host phone', [{ id: 'x', kind: 'phone', number: '+1234567890123456' }]],
    ['leading zero phone', [{ id: 'x', kind: 'phone', number: '+01234567' }]],
    ['non-string host phone', [{ id: 'x', kind: 'phone', number: 14155550123 }]],
    ['false askInvitee', [{ id: 'x', kind: 'phone', askInvitee: false }]],
    ['string askInvitee', [{ id: 'x', kind: 'phone', askInvitee: 'true' }]],
    ['both phone modes', [{ id: 'x', kind: 'phone', askInvitee: true, number: '+14155550123' }]],
    ['missing address', [{ id: 'x', kind: 'in_person' }]],
    ['empty address', [{ id: 'x', kind: 'in_person', address: ' ' }]],
    ['long address', [{ id: 'x', kind: 'in_person', address: 'x'.repeat(501) }]],
    ['missing URL', [{ id: 'x', kind: 'link' }]],
    ['relative URL', [{ id: 'x', kind: 'link', url: '/room' }]],
    ['invalid URL', [{ id: 'x', kind: 'link', url: 'https://[invalid' }]],
    ['unsafe URL scheme', [{ id: 'x', kind: 'link', url: 'javascript:alert(1)' }]],
    [
      'long raw URL',
      [{ id: 'x', kind: 'link', url: `https://EXAMPLE.com:443/${'x'.repeat(1979)}` }],
    ],
    [
      'long normalized URL',
      [{ id: 'x', kind: 'link', url: `https://example.com/${'東'.repeat(300)}` }],
    ],
  ])('refuses %s', (_, value) => {
    expect(() => validateLocationOptions(value)).toThrow(
      expect.objectContaining({ kind: 'invalid', code: 'invalid_locations' }),
    )
  })

  it.each(['\n', '\r', '\t', '\0', '\u0085', '\u2028', '\u2029', '\ud800'])(
    'refuses embedded invalid text %j in every text field',
    (bad) => {
      for (const option of [
        { id: 'x', kind: 'zoom', label: `a${bad}b` },
        { id: 'x', kind: 'in_person', address: `a${bad}b` },
        { id: 'x', kind: 'link', url: `https://example.com/a${bad}b` },
      ])
        expect(() => validateLocationOptions([option])).toThrowError()
    },
  )
})

describe('legacy compatibility and public projection', () => {
  it('matches the question and reminder id reservation without rejecting other object member names', () => {
    for (const id of ['constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf'])
      expect(validateLocationOptions([{ id, kind: 'zoom' }])).toEqual([{ id, kind: 'zoom' }])
  })

  it.each(allKinds)('round trips the original $kind settings through one option', (option) => {
    const { id: _id, ...settings } = option
    expect(compatLocation(locationOptionsFromLegacy(settings as EventTypeLocation))).toEqual(
      settings,
    )
    expect(locationOptionsFromLegacy(settings as EventTypeLocation)).toEqual([
      { ...settings, id: 'legacy' },
    ])
  })

  it('keeps no location null and derives compatibility from the default/first settings', () => {
    expect(locationOptionsFromLegacy(null)).toBeNull()
    expect(compatLocation(null)).toBeNull()
    const first: LocationOption = { id: 'first', kind: 'phone', askInvitee: true, label: 'Call me' }
    const second: LocationOption = { id: 'second', kind: 'zoom', isDefault: true, label: 'Video' }
    expect(compatLocation([first, second])).toEqual({ kind: 'zoom' })
    expect(compatLocation([first])).toEqual({ kind: 'phone', askInvitee: true })
  })

  it('allocates copies for legacy settings and compat reads', () => {
    const settings: EventTypeLocation = { kind: 'in_person', address: 'Before' }
    const options = locationOptionsFromLegacy(settings)
    settings.address = 'After'
    expect(options?.[0]).toEqual({ kind: 'in_person', address: 'Before', id: 'legacy' })
    const compat = compatLocation(options)
    if (compat?.kind === 'in_person') compat.address = 'Other'
    expect(options?.[0]).toEqual({ kind: 'in_person', address: 'Before', id: 'legacy' })
  })

  it('keeps every option, label, default and order when legacy settings are echoed', () => {
    const options: LocationOption[] = [
      { id: 'office', kind: 'in_person', address: 'Office', label: 'Headquarters' },
      { id: 'call', kind: 'phone', askInvitee: true, isDefault: true },
    ]
    expect(applyLegacyLocation(options, { askInvitee: true, kind: 'phone' })).toBe(options)
    expect(
      applyLegacyLocation([options[0] as LocationOption], { kind: 'in_person', address: 'Office' }),
    ).toEqual([options[0]])
    expect(applyLegacyLocation(null, null)).toBeNull()
  })

  it('recognizes exact echoes of nested historical JSON independently of object identity', () => {
    const location = {
      kind: 'link' as const,
      url: 'https://example.com/room',
      historical: { rooms: [{ name: 'Main room', floor: 2 }], flags: [true, null] },
    }
    const options = [{ ...location, id: 'room', label: 'Room' }]
    expect(applyLegacyLocation(options, structuredClone(location))).toBe(options)
  })

  it('updates singleton settings in place and preserves the default marker', () => {
    const options: LocationOption[] = [
      { id: 'office', kind: 'in_person', address: 'Before', isDefault: true },
    ]
    expect(applyLegacyLocation(options, { kind: 'in_person', address: 'After' })).toEqual([
      { id: 'office', kind: 'in_person', address: 'After', isDefault: true },
    ])
    expect(options[0]).toEqual({
      id: 'office',
      kind: 'in_person',
      address: 'Before',
      isDefault: true,
    })
    expect(applyLegacyLocation(options, null)).toBeNull()
  })

  it('allocates a new identity for a changed kind or re-created option', () => {
    const changed = applyLegacyLocation(
      [{ id: 'office', kind: 'in_person', address: 'Office', isDefault: true }],
      { kind: 'phone', number: '+14155550123' },
    )
    expect(changed?.[0]).toMatchObject({
      kind: 'phone',
      number: '+14155550123',
      isDefault: true,
    })
    expect(changed?.[0]?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(changed?.[0]?.id).not.toBe('office')
    const first = applyLegacyLocation(null, { kind: 'zoom' })
    const recreated = applyLegacyLocation(null, { kind: 'zoom' })
    expect(first?.[0]?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(recreated?.[0]?.id).not.toBe(first?.[0]?.id)
  })

  it.each([
    {
      options: [
        { id: 'office', kind: 'in_person', address: 'Office' },
        { id: 'video', kind: 'zoom' },
      ],
    },
    { options: [{ id: 'office', kind: 'in_person', address: 'Office', label: 'HQ' }] },
  ] satisfies { options: LocationOption[] }[])(
    'rejects changed or cleared legacy settings for rich options %j',
    ({ options }) => {
      for (const location of [null, { kind: 'zoom' as const }])
        expect(() => applyLegacyLocation(options, location)).toThrow(
          expect.objectContaining({
            kind: 'conflict',
            code: 'location_options_conflict',
            message: expect.stringContaining('locations'),
          }),
        )
    },
  )

  it('exposes only safe metadata and invitee collection requirements', () => {
    expect(publicLocationOptions(allKinds)).toEqual(allKinds.map(({ id, kind }) => ({ id, kind })))
    expect(
      publicLocationOptions([
        { id: 'call', kind: 'phone', askInvitee: true, label: 'Phone', isDefault: true },
      ]),
    ).toEqual([{ id: 'call', kind: 'phone', askInvitee: true, label: 'Phone', isDefault: true }])
    expect(publicLocationOptions(null)).toBeNull()
  })
})

describe('location choice resolution', () => {
  it.each(allKinds)('resolves $kind into settings and a detached option snapshot', (option) => {
    const { id: _id, ...settings } = option
    const input = { ...option, label: 'Selected', isDefault: true as const }
    const result = resolveLocationChoice([input], {}, context)
    expect(result).toEqual({ locationOption: input, location: settings })
    input.label = 'Changed'
    expect(result.locationOption?.label).toBe('Selected')
    expect(result.location).not.toBe(result.locationOption)
  })

  it('selects an explicit choice before the default and otherwise uses the default/first', () => {
    const options: LocationOption[] = [
      { id: 'office', kind: 'in_person', address: 'Office' },
      { id: 'call', kind: 'phone', number: '+14155550123', isDefault: true },
    ]
    expect(resolveLocationChoice(options, {}, context).locationOption?.id).toBe('call')
    expect(resolveLocationChoice(options, { optionId: 'office' }, context).locationOption?.id).toBe(
      'office',
    )
    expect(
      resolveLocationChoice([options[0] as LocationOption], {}, context).locationOption?.id,
    ).toBe('office')
    expect(resolveLocationChoice(null, {}, context)).toEqual({
      locationOption: null,
      location: null,
    })
  })

  it.each([null, allKinds])('refuses an unknown selected ID with locations %j', (options) => {
    expect(() => resolveLocationChoice(options, { optionId: 'missing' }, context)).toThrow(
      expect.objectContaining({ code: 'invalid_location_choice', kind: 'invalid' }),
    )
  })

  it('collects an invitee number into the resolved location without rewriting the option snapshot', () => {
    expect(
      resolveLocationChoice(
        [{ id: 'call', kind: 'phone', askInvitee: true }],
        { inviteePhone: '+14155550123' },
        context,
      ),
    ).toEqual({
      locationOption: { id: 'call', kind: 'phone', askInvitee: true },
      location: { kind: 'phone', number: '+14155550123' },
    })
    expect(
      resolveLocationChoice(
        [{ id: 'call', kind: 'phone', number: '+14155550123' }],
        { inviteePhone: 'unused' },
        context,
      ).location,
    ).toEqual({ kind: 'phone', number: '+14155550123' })
  })

  it.each(['+1 415 555 0123', '+1 (415) 555-0123', '+1.415.555.0123'])(
    'normalizes collected phone %s',
    (inviteePhone) => {
      expect(
        resolveLocationChoice(
          [{ id: 'call', kind: 'phone', askInvitee: true }],
          { inviteePhone },
          context,
        ).location,
      ).toEqual({ kind: 'phone', number: '+14155550123' })
    },
  )

  it.each([
    undefined,
    '',
    '4155550123',
    '+01234567',
    '+123456',
    '+1234567890123456',
    '+1415\n5550123',
  ])('refuses an invalid collected phone %j', (inviteePhone) => {
    expect(() =>
      resolveLocationChoice(
        [{ id: 'call', kind: 'phone', askInvitee: true }],
        { inviteePhone },
        context,
      ),
    ).toThrow(expect.objectContaining({ kind: 'invalid', code: 'invalid_invitee_phone' }))
  })

  it('keeps passive conference behavior without requiring connected accounts', () => {
    for (const kind of ['google_meet', 'zoom'] as const) {
      expect(
        resolveLocationChoice(
          [{ id: 'video', kind }],
          {},
          { schedulingType: 'collective', hostUserIds: ['a', 'b'] },
        ).location,
      ).toEqual({ kind })
    }
  })

  it('supports a required collective Meet organizer and the assigned round-robin host', () => {
    const option: LocationOption = { id: 'meet', kind: 'google_meet', autoCreate: true }
    for (const mode of ['collective', 'round_robin'] as const) {
      const facts = {
        schedulingType: mode,
        hostUserIds: ['a', 'b'],
        meetReadyHostUserIds: ['b'],
        ...(mode === 'collective'
          ? { conferenceOrganizerUserId: 'b' }
          : { assignedHostUserId: 'b' }),
      }
      expect(resolveLocationChoice([option], {}, facts).location).toEqual({
        kind: 'google_meet',
        autoCreate: true,
      })
    }
  })

  it.each([
    [
      'individual Meet account disconnected',
      'google_meet',
      { ...context, meetReadyHostUserIds: [] },
    ],
    ['individual Zoom account disconnected', 'zoom', { ...context, zoomReadyHostUserIds: [] }],
    ['individual host missing', 'google_meet', { ...context, hostUserIds: [] }],
    ['individual multiple hosts', 'google_meet', { ...context, hostUserIds: ['host', 'other'] }],
    [
      'individual assigned outsider',
      'google_meet',
      { ...context, assignedHostUserId: 'outsider', meetReadyHostUserIds: ['outsider'] },
    ],
    [
      'individual organizer override',
      'google_meet',
      { ...context, conferenceOrganizerUserId: 'host' },
    ],
    [
      'collective missing organizer',
      'google_meet',
      {
        schedulingType: 'collective',
        hostUserIds: ['host', 'other'],
        meetReadyHostUserIds: ['host'],
      },
    ],
    [
      'collective outsider organizer',
      'google_meet',
      {
        schedulingType: 'collective',
        hostUserIds: ['host', 'other'],
        conferenceOrganizerUserId: 'outsider',
        meetReadyHostUserIds: ['outsider'],
      },
    ],
    [
      'collective disconnected organizer',
      'google_meet',
      {
        schedulingType: 'collective',
        hostUserIds: ['host', 'other'],
        conferenceOrganizerUserId: 'other',
        meetReadyHostUserIds: ['host'],
      },
    ],
    [
      'round-robin unassigned host',
      'google_meet',
      {
        schedulingType: 'round_robin',
        hostUserIds: ['host', 'other'],
        meetReadyHostUserIds: ['host'],
      },
    ],
    [
      'round-robin outsider assignment',
      'google_meet',
      {
        schedulingType: 'round_robin',
        hostUserIds: ['host'],
        assignedHostUserId: 'outsider',
        meetReadyHostUserIds: ['outsider'],
      },
    ],
    [
      'round-robin disconnected assignee',
      'google_meet',
      {
        schedulingType: 'round_robin',
        hostUserIds: ['host', 'other'],
        assignedHostUserId: 'other',
        meetReadyHostUserIds: ['host'],
      },
    ],
    [
      'round-robin organizer override',
      'google_meet',
      {
        schedulingType: 'round_robin',
        hostUserIds: ['host'],
        assignedHostUserId: 'host',
        conferenceOrganizerUserId: 'host',
        meetReadyHostUserIds: ['host'],
      },
    ],
    [
      'collective automatic Zoom',
      'zoom',
      {
        schedulingType: 'collective',
        hostUserIds: ['host', 'other'],
        conferenceOrganizerUserId: 'host',
        zoomReadyHostUserIds: ['host'],
      },
    ],
    [
      'round-robin automatic Zoom',
      'zoom',
      {
        schedulingType: 'round_robin',
        hostUserIds: ['host'],
        assignedHostUserId: 'host',
        zoomReadyHostUserIds: ['host'],
      },
    ],
    [
      'individual automatic Zoom multiple hosts',
      'zoom',
      { ...context, hostUserIds: ['host', 'other'] },
    ],
  ] as const)('refuses %s as location_unavailable', (_, kind, facts) => {
    expect(() =>
      resolveLocationChoice([{ id: 'video', kind, autoCreate: true }], {}, facts),
    ).toThrow(expect.objectContaining({ kind: 'conflict', code: 'location_unavailable' }))
  })
})
