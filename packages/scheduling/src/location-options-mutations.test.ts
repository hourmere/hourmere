import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import { expectKilled, guardCopy } from '../../../scripts/source-copy-guard.ts'
import * as Options from './location-options.ts'

async function sourceCopy(mutate: (source: string) => string) {
  const location = new URL('./location-options.ts', import.meta.url)
  const original = readFileSync(location, 'utf8')
  const modified = mutate(original)
  expect(modified).not.toBe(original)
  const source = stripTypeScriptTypes(modified).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return guardCopy(
    (await import(
      `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    )) as typeof Options,
  )
}

const reject = (module: typeof Options, value: unknown) =>
  expect(() => module.validateLocationOptions(value)).toThrowError()
const one = { id: 'one', kind: 'zoom' }
const context: Options.LocationChoiceContext = {
  schedulingType: 'individual',
  hostUserIds: ['host'],
  meetReadyHostUserIds: ['host'],
  zoomReadyHostUserIds: ['host'],
}
const meet: Options.LocationOption = { id: 'video', kind: 'google_meet', autoCreate: true }
const zoom: Options.LocationOption = { id: 'video', kind: 'zoom', autoCreate: true }
const rejectsChoice = (
  module: typeof Options,
  option: Options.LocationOption,
  facts: Options.LocationChoiceContext,
) => expect(() => module.resolveLocationChoice([option], {}, facts)).toThrowError()

describe('location option source-copy mutation controls', () => {
  it.each([
    {
      name: 'list shape',
      mutate: (source: string) => source.replace('!Array.isArray(value) ||', 'false ||'),
      verify: (module: typeof Options) =>
        reject(module, { 0: one, length: 1, map: Array.prototype.map }),
    },
    {
      name: 'minimum option count',
      mutate: (source: string) => source.replace('value.length < 1', 'false'),
      verify: (module: typeof Options) => reject(module, []),
    },
    {
      name: 'maximum option count',
      mutate: (source: string) =>
        source
          .replace('value.length > LOCATION_OPTION_LIMITS.count', 'false')
          .replace('usedKinds.has(kind as string)', 'false'),
      // Distinct kinds independently cap a valid list at five; relax that redundant
      // backstop too so removing the count guard can produce an observable violation.
      verify: (module: typeof Options) =>
        reject(
          module,
          Array.from({ length: 6 }, (_, index) => ({ id: `id${index}`, kind: 'zoom' })),
        ),
    },
    {
      name: 'option object shape',
      mutate: (source: string) => source.replace('!record(item)', 'false'),
      verify: (module: typeof Options) => reject(module, [Object.assign([], one)]),
    },
    {
      name: 'id type',
      mutate: (source: string) => source.replace("typeof id !== 'string' ||", 'false ||'),
      verify: (module: typeof Options) => reject(module, [{ ...one, id: 123 }]),
    },
    {
      name: 'id length',
      mutate: (source: string) => source.replace('id.length > LOCATION_OPTION_LIMITS.id', 'false'),
      verify: (module: typeof Options) => reject(module, [{ ...one, id: 'x'.repeat(65) }]),
    },
    {
      name: 'id alphabet and minimum length',
      mutate: (source: string) => source.replace('!OPTION_ID.test(id)', 'false'),
      verify: (module: typeof Options) => {
        reject(module, [{ ...one, id: '' }])
        reject(module, [{ ...one, id: 'a b' }])
      },
    },
    {
      name: 'reserved option id',
      mutate: (source: string) => source.replace("if (id === '__proto__')", 'if (false)'),
      verify: (module: typeof Options) => reject(module, [{ ...one, id: '__proto__' }]),
    },
    {
      name: 'distinct ids',
      mutate: (source: string) => source.replace('ids.has(id)', 'false'),
      verify: (module: typeof Options) => reject(module, [one, { id: 'one', kind: 'google_meet' }]),
    },
    {
      name: 'supported kinds',
      mutate: (source: string) =>
        source
          .replace(
            "return invalid('Choose a supported location kind')",
            'return { id, kind } as LocationOption',
          )
          .replace(
            "return invalid('Choose a supported location kind')",
            'return { id, kind } as LocationOption',
          ),
      verify: (module: typeof Options) => reject(module, [{ id: 'one', kind: 'teams' }]),
    },
    {
      name: 'distinct kinds',
      mutate: (source: string) => source.replace('usedKinds.has(kind as string)', 'false'),
      verify: (module: typeof Options) => reject(module, [one, { id: 'two', kind: 'zoom' }]),
    },
    {
      name: 'label type',
      mutate: (source: string) =>
        source.replace(
          'cleanText(item.label, { max: LOCATION_OPTION_LIMITS.label })',
          'String(item.label)',
        ),
      verify: (module: typeof Options) => reject(module, [{ ...one, label: 123 }]),
    },
    {
      name: 'nonempty label',
      mutate: (source: string) =>
        source.replace(
          'max: LOCATION_OPTION_LIMITS.label',
          'max: LOCATION_OPTION_LIMITS.label, min: 0',
        ),
      verify: (module: typeof Options) => reject(module, [{ ...one, label: ' ' }]),
    },
    {
      name: 'label length',
      mutate: (source: string) =>
        source.replace('max: LOCATION_OPTION_LIMITS.label', 'max: Number.POSITIVE_INFINITY'),
      verify: (module: typeof Options) => reject(module, [{ ...one, label: 'x'.repeat(101) }]),
    },
    {
      name: 'single-line well-formed label',
      mutate: (source: string) =>
        source.replace(
          'cleanText(item.label, { max: LOCATION_OPTION_LIMITS.label })',
          'item.label as string',
        ),
      verify: (module: typeof Options) => {
        reject(module, [{ ...one, label: 'a\nb' }])
        reject(module, [{ ...one, label: '\ud800' }])
      },
    },
    {
      name: 'default flag type',
      mutate: (source: string) =>
        source.replace('item.isDefault !== undefined && item.isDefault !== true', 'false'),
      verify: (module: typeof Options) => reject(module, [{ ...one, isDefault: false }]),
    },
    {
      name: 'single default',
      mutate: (source: string) => source.replace('defaults > 1', 'false'),
      verify: (module: typeof Options) =>
        reject(module, [
          { ...one, isDefault: true },
          { id: 'two', kind: 'google_meet', isDefault: true },
        ]),
    },
    {
      name: 'strict per-kind keys',
      mutate: (source: string) =>
        source.replace(
          /Object\.keys\(item\)\.some\(\s*\(key\) => !\['id', 'kind', 'label', 'isDefault', \.\.\.settings\]\.includes\(key\),?\s*\)/,
          'false',
        ),
      verify: (module: typeof Options) => {
        for (const option of [
          one,
          { id: 'call', kind: 'phone', number: '+14155550123' },
          { id: 'office', kind: 'in_person', address: 'Office' },
          { id: 'link', kind: 'link', url: 'https://example.com' },
        ])
          reject(module, [{ ...option, extra: true }])
      },
    },
    {
      name: 'automatic conference opt-in type',
      mutate: (source: string) =>
        source.replace('item.autoCreate !== undefined && item.autoCreate !== true', 'false'),
      verify: (module: typeof Options) => reject(module, [{ ...one, autoCreate: false }]),
    },
    {
      name: 'invitee phone mode type',
      mutate: (source: string) => source.replace('item.askInvitee !== true ||', 'false ||'),
      verify: (module: typeof Options) =>
        reject(module, [{ id: 'call', kind: 'phone', askInvitee: false }]),
    },
    {
      name: 'exclusive phone modes',
      mutate: (source: string) => source.replace('item.number !== undefined)', 'false)'),
      verify: (module: typeof Options) =>
        reject(module, [{ id: 'call', kind: 'phone', askInvitee: true, number: '+14155550123' }]),
    },
    {
      name: 'host phone type',
      mutate: (source: string) => source.replace("typeof item.number !== 'string' ||", 'false ||'),
      verify: (module: typeof Options) =>
        reject(module, [{ id: 'call', kind: 'phone', number: { toString: () => '+14155550123' } }]),
    },
    {
      name: 'host E.164 number',
      mutate: (source: string) => source.replace('!PHONE_NUMBER.test(item.number)', 'false'),
      verify: (module: typeof Options) =>
        reject(module, [{ id: 'call', kind: 'phone', number: 'invalid' }]),
    },
    {
      name: 'address type',
      mutate: (source: string) =>
        source.replace(
          'cleanText(item.address, { max: LOCATION_OPTION_LIMITS.address })',
          'String(item.address)',
        ),
      verify: (module: typeof Options) =>
        reject(module, [{ id: 'office', kind: 'in_person', address: 123 }]),
    },
    {
      name: 'nonempty address',
      mutate: (source: string) =>
        source.replace(
          'max: LOCATION_OPTION_LIMITS.address',
          'max: LOCATION_OPTION_LIMITS.address, min: 0',
        ),
      verify: (module: typeof Options) =>
        reject(module, [{ id: 'office', kind: 'in_person', address: ' ' }]),
    },
    {
      name: 'address length',
      mutate: (source: string) =>
        source.replace('max: LOCATION_OPTION_LIMITS.address', 'max: Number.POSITIVE_INFINITY'),
      verify: (module: typeof Options) =>
        reject(module, [{ id: 'office', kind: 'in_person', address: 'x'.repeat(501) }]),
    },
    {
      name: 'single-line well-formed address',
      mutate: (source: string) =>
        source.replace(
          'cleanText(item.address, { max: LOCATION_OPTION_LIMITS.address })',
          'item.address as string',
        ),
      verify: (module: typeof Options) => {
        reject(module, [{ id: 'office', kind: 'in_person', address: 'a\nb' }])
        reject(module, [{ id: 'office', kind: 'in_person', address: '\ud800' }])
      },
    },
    {
      name: 'URL type',
      mutate: (source: string) =>
        source.replace(
          'cleanText(item.url, { max: LOCATION_OPTION_LIMITS.url })',
          'String(item.url)',
        ),
      verify: (module: typeof Options) =>
        reject(module, [{ id: 'link', kind: 'link', url: new URL('https://example.com') }]),
    },
    {
      name: 'raw URL length',
      mutate: (source: string) =>
        source.replace('max: LOCATION_OPTION_LIMITS.url', 'max: Number.POSITIVE_INFINITY'),
      verify: (module: typeof Options) =>
        reject(module, [
          { id: 'link', kind: 'link', url: `https://EXAMPLE.com:443/${'x'.repeat(1979)}` },
        ]),
    },
    {
      name: 'raw URL controls',
      mutate: (source: string) =>
        source.replace(
          'cleanText(item.url, { max: LOCATION_OPTION_LIMITS.url })',
          'item.url as string',
        ),
      verify: (module: typeof Options) =>
        reject(module, [{ id: 'link', kind: 'link', url: 'https://example.com/a\nb' }]),
    },
    {
      name: 'HTTP(S) link schemes',
      mutate: (source: string) =>
        source.replace("!['http:', 'https:'].includes(url.protocol)", 'false'),
      verify: (module: typeof Options) =>
        reject(module, [{ id: 'link', kind: 'link', url: 'javascript:alert(1)' }]),
    },
    {
      name: 'normalized URL length',
      mutate: (source: string) =>
        source.replace('url.href.length > LOCATION_OPTION_LIMITS.url', 'false'),
      verify: (module: typeof Options) =>
        reject(module, [
          { id: 'link', kind: 'link', url: `https://example.com/${'東'.repeat(300)}` },
        ]),
    },
    {
      name: 'legacy echo preserves rich options',
      mutate: (source: string) =>
        source.replace('return locations\n', 'return locationOptionsFromLegacy(location)\n'),
      verify: (module: typeof Options) => {
        const options: Options.LocationOption[] = [
          { id: 'office', kind: 'in_person', address: 'Office', label: 'Headquarters' },
          { id: 'call', kind: 'phone', askInvitee: true, isDefault: true },
        ]
        expect(module.applyLegacyLocation(options, { askInvitee: true, kind: 'phone' })).toEqual(
          options,
        )
      },
    },
    {
      name: 'legacy equality includes optional settings',
      mutate: (source: string) =>
        source.replace(
          'isDeepStrictEqual(current, location)',
          'current !== null && record(location) && Object.entries(current).every(([key, value]) => Reflect.get(location, key) === value)',
        ),
      verify: (module: typeof Options) =>
        expect(
          module.applyLegacyLocation([{ id: 'video', kind: 'zoom' }], {
            kind: 'zoom',
            autoCreate: true,
          }),
        ).toEqual([{ id: 'video', kind: 'zoom', autoCreate: true }]),
    },
    {
      name: 'legacy singleton settings update',
      mutate: (source: string) =>
        source.replace(
          'isDeepStrictEqual(current, location)',
          'current !== null && record(location) && Object.keys(current).length === Object.keys(location).length',
        ),
      verify: (module: typeof Options) =>
        expect(
          module.applyLegacyLocation([{ id: 'room', kind: 'in_person', address: 'Before' }], {
            kind: 'in_person',
            address: 'After',
          }),
        ).toEqual([{ id: 'room', kind: 'in_person', address: 'After' }]),
    },
    {
      name: 'deep historical legacy equality',
      mutate: (source: string) =>
        source.replace(
          'isDeepStrictEqual(current, location)',
          'current !== null && record(location) && Object.keys(current).length === Object.keys(location).length && Object.entries(current).every(([key, value]) => Reflect.get(location, key) === value)',
        ),
      verify: (module: typeof Options) => {
        const location = {
          kind: 'link' as const,
          url: 'https://example.com/room',
          historical: { rooms: [{ name: 'Main', floor: 2 }] },
        }
        const options = [{ ...location, id: 'room' }]
        expect(module.isLegacyLocationEcho(options, structuredClone(location))).toBe(true)
      },
    },
    {
      name: 'legacy singleton stable id',
      mutate: (source: string) =>
        source.replace(
          'previous?.kind === location.kind ? previous.id : crypto.randomUUID()',
          'crypto.randomUUID()',
        ),
      verify: (module: typeof Options) =>
        expect(
          module.applyLegacyLocation([{ id: 'room', kind: 'in_person', address: 'Before' }], {
            kind: 'in_person',
            address: 'After',
          })?.[0]?.id,
        ).toBe('room'),
    },
    {
      name: 'legacy singleton default marker',
      mutate: (source: string) => source.replace('previous?.isDefault === true', 'false'),
      verify: (module: typeof Options) =>
        expect(
          module.applyLegacyLocation(
            [{ id: 'room', kind: 'in_person', address: 'Before', isDefault: true }],
            { kind: 'in_person', address: 'After' },
          )?.[0]?.isDefault,
        ).toBe(true),
    },
    {
      name: 'legacy kind change rotates identity',
      mutate: (source: string) =>
        source.replace(
          'previous?.kind === location.kind ? previous.id : crypto.randomUUID()',
          'previous?.id ?? crypto.randomUUID()',
        ),
      verify: (module: typeof Options) =>
        expect(
          module.applyLegacyLocation([{ id: 'room', kind: 'in_person', address: 'Office' }], {
            kind: 'zoom',
          })?.[0]?.id,
        ).not.toBe('room'),
    },
    {
      name: 'legacy recreation allocates identity',
      mutate: (source: string) =>
        source.replace(
          'previous?.kind === location.kind ? previous.id : crypto.randomUUID()',
          "previous?.kind === location.kind ? previous.id : previous ? crypto.randomUUID() : 'legacy'",
        ),
      verify: (module: typeof Options) =>
        expect(module.applyLegacyLocation(null, { kind: 'zoom' })?.[0]?.id).toMatch(
          /^[0-9a-f-]{36}$/,
        ),
    },
    {
      name: 'legacy multi-option conflict',
      mutate: (source: string) => source.replace('locations.length > 1 ||', 'false ||'),
      verify: (module: typeof Options) =>
        expect(() =>
          module.applyLegacyLocation(
            [
              { id: 'room', kind: 'in_person', address: 'Office' },
              { id: 'video', kind: 'zoom' },
            ],
            null,
          ),
        ).toThrowError(),
    },
    {
      name: 'legacy labelled-option conflict',
      mutate: (source: string) => source.replace('locations[0]?.label !== undefined', 'false'),
      verify: (module: typeof Options) =>
        expect(() =>
          module.applyLegacyLocation(
            [{ id: 'room', kind: 'in_person', address: 'Office', label: 'Headquarters' }],
            null,
          ),
        ).toThrowError(),
    },
    {
      name: 'compat default preference',
      mutate: (source: string) =>
        source.replace(
          'locations?.find((item) => item.isDefault === true) ?? locations?.[0]',
          'locations?.[0]',
        ),
      verify: (module: typeof Options) =>
        expect(
          module.compatLocation([
            { ...one, kind: 'zoom' },
            { id: 'two', kind: 'google_meet', isDefault: true },
          ]),
        ).toEqual({ kind: 'google_meet' }),
    },
    {
      name: 'compat settings projection',
      mutate: (source: string) => source.replace('return settings\n', 'return option\n'),
      verify: (module: typeof Options) =>
        expect(
          module.compatLocation([{ id: 'one', kind: 'zoom', label: 'Video', isDefault: true }]),
        ).toEqual({ kind: 'zoom' }),
    },
    {
      name: 'public private-data projection',
      mutate: (source: string) => source.replace('id: option.id,', '...option, id: option.id,'),
      verify: (module: typeof Options) =>
        expect(
          module.publicLocationOptions([{ id: 'call', kind: 'phone', number: '+14155550123' }]),
        ).toEqual([{ id: 'call', kind: 'phone' }]),
    },
    {
      name: 'unknown choice refusal',
      mutate: (source: string) => source.replace('optionId !== undefined && !option', 'false'),
      verify: (module: typeof Options) =>
        expect(() =>
          module.resolveLocationChoice([zoom], { optionId: 'missing' }, context),
        ).toThrowError(),
    },
    {
      name: 'chosen option snapshot detachment',
      mutate: (source: string) =>
        source.replace(
          'const options = validateLocationOptions(locations)',
          'const options = locations',
        ),
      verify: (module: typeof Options) => {
        const option: Options.LocationOption = { id: 'room', kind: 'in_person', address: 'Before' }
        const result = module.resolveLocationChoice([option], {}, context)
        option.address = 'After'
        expect(result.locationOption).toEqual({ id: 'room', kind: 'in_person', address: 'Before' })
      },
    },
    {
      name: 'invitee phone separator normalization',
      mutate: (source: string) =>
        source.replace("input.inviteePhone.replace(/[ ().-]/g, '')", 'input.inviteePhone'),
      verify: (module: typeof Options) => {
        let actual: unknown
        try {
          actual = module.resolveLocationChoice(
            [{ id: 'call', kind: 'phone', askInvitee: true }],
            { inviteePhone: '+1 (415) 555-0123' },
            context,
          ).location
        } catch {
          actual = null
        }
        expect(actual).toEqual({ kind: 'phone', number: '+14155550123' })
      },
    },
    {
      name: 'invitee E.164 phone',
      mutate: (source: string) => source.replace('!PHONE_NUMBER.test(phone)', 'false'),
      verify: (module: typeof Options) =>
        expect(() =>
          module.resolveLocationChoice(
            [{ id: 'call', kind: 'phone', askInvitee: true }],
            { inviteePhone: 'invalid' },
            context,
          ),
        ).toThrowError(),
    },
    {
      name: 'individual single-host policy',
      mutate: (source: string) =>
        source.replace(
          'if (hosts.length !== 1) return unavailable()',
          'if (false) return unavailable()',
        ),
      verify: (module: typeof Options) =>
        rejectsChoice(module, meet, { ...context, hostUserIds: ['host', 'other'] }),
    },
    {
      name: 'collective organizer requirement',
      mutate: (source: string) =>
        source.replace(
          'organizer = context.conferenceOrganizerUserId ?? undefined',
          'organizer = hosts[0]',
        ),
      verify: (module: typeof Options) =>
        rejectsChoice(module, meet, {
          ...context,
          schedulingType: 'collective',
          hostUserIds: ['host', 'other'],
        }),
    },
    {
      name: 'round-robin assigned host requirement',
      mutate: (source: string) =>
        source.replace('organizer = context.assignedHostUserId\n', 'organizer = hosts[0]\n'),
      verify: (module: typeof Options) =>
        rejectsChoice(module, meet, { ...context, schedulingType: 'round_robin' }),
    },
    {
      name: 'organizer membership',
      mutate: (source: string) => source.replace('!hosts.includes(organizer)', 'false'),
      verify: (module: typeof Options) =>
        rejectsChoice(module, meet, {
          ...context,
          assignedHostUserId: 'outsider',
          meetReadyHostUserIds: ['outsider'],
        }),
    },
    {
      name: 'no organizer override outside collective',
      mutate: (source: string) =>
        source.replace(
          "mode !== 'collective' && context.conferenceOrganizerUserId != null",
          'false',
        ),
      verify: (module: typeof Options) =>
        rejectsChoice(module, meet, { ...context, conferenceOrganizerUserId: 'host' }),
    },
    {
      name: 'Meet readiness',
      mutate: (source: string) =>
        source.replace('!context.meetReadyHostUserIds?.includes(organizer)', 'false'),
      verify: (module: typeof Options) =>
        rejectsChoice(module, meet, { ...context, meetReadyHostUserIds: [] }),
    },
    {
      name: 'Zoom individual host policy',
      mutate: (source: string) =>
        source.replace(/mode !== 'individual' \|\|\s*hosts.length !== 1 \|\|/, ''),
      verify: (module: typeof Options) =>
        rejectsChoice(module, zoom, {
          ...context,
          schedulingType: 'collective',
          hostUserIds: ['host', 'other'],
          conferenceOrganizerUserId: 'host',
        }),
    },
    {
      name: 'Zoom readiness',
      mutate: (source: string) =>
        source.replace('!context.zoomReadyHostUserIds?.includes(organizer)', 'false'),
      verify: (module: typeof Options) =>
        rejectsChoice(module, zoom, { ...context, zoomReadyHostUserIds: [] }),
    },
  ])(
    'detects removed $name protection with a real assertion failure',
    async ({ mutate, verify }) => {
      verify(Options)
      const copy = await sourceCopy(mutate)
      await expectKilled(copy, verify)
    },
  )
})
