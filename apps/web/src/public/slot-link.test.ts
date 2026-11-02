import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import { parseSlotLink } from './slot-link.ts'
import { dateKeyIn, wallTime } from './time.ts'

const start = '2027-06-15T14:30:00.000Z'
const query = (instant = start, duration = '30') =>
  `?${new URLSearchParams({ start: instant, durationMinutes: duration })}`
const valid = query()

function assertInputs(parse: typeof parseSlotLink) {
  expect(parse('')).toEqual({ status: 'none' })
  expect(parse('?utm_source=email&locale=de&timeZone=UTC')).toEqual({ status: 'none' })
  expect(parse(valid)).toEqual({
    status: 'valid',
    start,
    end: '2027-06-15T15:00:00.000Z',
    durationMinutes: 30,
  })
  expect(
    parse(`${valid}&end=1900-01-01&hostId=other&redirect=https://example.com&signature=forged`),
  ).toEqual(parse(valid))
  expect(parse(`${valid}&locale=de&timeZone=Europe%2FBerlin&source=mcp`)).toEqual(parse(valid))
  expect(parse(`${valid}&ignored=a&ignored=b`)).toEqual(parse(valid))
  for (const value of [
    '?start=',
    '?durationMinutes=30',
    '?start=2027-06-15T14%3A30%3A00.000Z',
    '?start=&durationMinutes=30',
    `${valid}&start=${encodeURIComponent(start)}`,
    `${valid}&%73tart=${encodeURIComponent(start)}`,
    `${valid}&durationMinutes=30`,
    `${valid}&duration%4Dinutes=60`,
    `${valid}&ignored=%`,
    `${valid}&ignored=%2`,
    `${valid}&ignored=%GG`,
    `${valid}&ignored=%C0%AF`,
    `${valid}&ignored=%E2%28%A1`,
    `${valid}&ignored=%ED%A0%80`,
    '?start=2027-06-15T14%3A30%3A00.000Z&durationMinutes=%',
  ])
    expect(parse(value), 'reject malformed pairs without partial selection').toEqual({
      status: 'invalid',
    })
  for (const instant of [
    '2027-02-30T14:30:00Z',
    '2027-02-29T14:30:00Z',
    '1900-02-29T14:30:00Z',
    '2027-04-31T14:30:00Z',
    '2027-00-15T14:30:00Z',
    '2027-13-15T14:30:00Z',
    '2027-06-00T14:30:00Z',
    '2027-06-32T14:30:00Z',
    '2027-06-15T24:00:00Z',
    '2027-06-15T25:30:00Z',
    '2027-06-15T14:60:00Z',
    '2027-06-15T14:30:60Z',
    '2027-06-15T14:30:00.0001Z',
    '2027-06-15T14:30:00.123456789Z',
    '2027-06-15T14:30:00.Z',
    '2027-06-15T14:30:00',
    '2027-06-15T14:30Z',
    '2027-06-15',
    '2027-6-15T14:30:00Z',
    '2027-06-15 14:30:00Z',
    '2027-06-15t14:30:00z',
    '2027-06-15T14:30:00+24:00',
    '2027-06-15T14:30:00-24:00',
    '2027-06-15T14:30:00+01:60',
    '2027-06-15T14:30:00+0100',
    '2027-06-15T14:30:00+01',
    '2027-06-15T14:30:00+01:00:30',
    '2027-06-15T14:30:00Z[UTC]',
    '0000-06-15T14:30:00Z',
    '10000-06-15T14:30:00Z',
    '+010000-06-15T14:30:00Z',
    '-000001-06-15T14:30:00Z',
    ' 2027-06-15T14:30:00Z',
    '2027-06-15T14:30:00Z\n',
    'invalid',
  ])
    expect(parse(query(instant)), 'reject invalid ISO input without coercion').toEqual({
      status: 'invalid',
    })
  for (const duration of [
    '',
    '0',
    '-1',
    '+30',
    '030',
    '1.5',
    '30.0',
    '3e1',
    '0x1e',
    ' 30',
    '30 ',
    '30\n',
    'Infinity',
    'NaN',
    '1441',
    '9999',
    '9007199254740992',
    '９０',
  ])
    expect(parse(query(start, duration)), 'reject noncanonical or unsupported duration').toEqual({
      status: 'invalid',
    })
  for (const instant of ['0001-01-01T00:00:00+00:01', '9999-12-31T23:59:00-00:01'])
    expect(parse(query(instant, '1')), 'normalized start must use a supported year').toEqual({
      status: 'invalid',
    })
  expect(parse(query('9999-12-31T23:59:59.999Z', '1'))).toEqual({ status: 'invalid' })
  const prefix = `${valid}&ignored=`
  const exact = prefix + 'a'.repeat(2048 - prefix.length - '/ada/intro'.length)
  expect(parse(exact, '/ada/intro').status).toBe('valid')
  expect(parse(`${exact}a`, '/ada/intro')).toEqual({ status: 'invalid' })
  expect(parse(`${prefix}${'é'.repeat(1000)}`, '/ada/intro')).toEqual({ status: 'invalid' })
}

describe('ordinary slot link input', () => {
  it('accepts a complete bounded pair and rejects malformed or coercible input', () => {
    assertInputs(parseSlotLink)
  })

  it.each([
    ['2027-06-15T16:30:00+02:00', start],
    ['2027-06-15T09:00:00-05:30', start],
    ['2027-06-15T14:30:00Z', start],
    ['2027-06-15T14:30:00.1Z', '2027-06-15T14:30:00.100Z'],
    ['2027-06-15T14:30:00.12Z', '2027-06-15T14:30:00.120Z'],
    ['2000-02-29T14:30:00Z', '2000-02-29T14:30:00.000Z'],
    ['2028-02-29T14:30:00Z', '2028-02-29T14:30:00.000Z'],
    ['0001-01-01T00:00:00Z', '0001-01-01T00:00:00.000Z'],
    ['9999-12-31T23:58:59.999Z', '9999-12-31T23:58:59.999Z'],
  ])('canonicalizes the explicit instant %s', (input, expected) => {
    const parsed = parseSlotLink(query(input, '1'))
    expect(parsed).toMatchObject({ status: 'valid', start: expected, durationMinutes: 1 })
    if (parsed.status === 'valid')
      expect(Date.parse(parsed.end) - Date.parse(parsed.start)).toBe(60_000)
  })

  it('accepts the maximum duration and encoded keys, without selecting a supplied end', () => {
    expect(parseSlotLink(`${query(start, '1440')}&end=invalid`)).toEqual({
      status: 'valid',
      start,
      end: '2027-06-16T14:30:00.000Z',
      durationMinutes: 1440,
    })
    expect(parseSlotLink(valid.replace('start=', '%73tart='))).toEqual(parseSlotLink(valid))
  })
})

const vectors = [
  ['New York spring', '2027-03-14T01:30:00-05:00', '2027-03-14T07:30:00.000Z'],
  ['New York repeat', '2027-11-07T01:30:00-04:00', '2027-11-07T06:30:00.000Z'],
  ['Berlin spring', '2027-03-28T01:30:00+01:00', '2027-03-28T01:30:00.000Z'],
  ['Berlin repeat', '2027-10-31T02:30:00+02:00', '2027-10-31T01:30:00.000Z'],
  ['Tokyo midnight', '2027-06-15T23:30:00+09:00', '2027-06-15T15:30:00.000Z'],
  ['Different host date', '2027-06-15T15:30:00+09:00', '2027-06-15T07:30:00.000Z'],
] as const

function assertElapsed(parse: typeof parseSlotLink) {
  for (const [_label, input, end] of vectors) {
    const parsed = parse(query(input, '60'))
    expect(parsed).toMatchObject({ status: 'valid', end, durationMinutes: 60 })
    if (parsed.status === 'valid')
      expect(Date.parse(parsed.end) - Date.parse(parsed.start)).toBe(3_600_000)
  }
}

describe('slot link elapsed duration', () => {
  it('keeps all accepted contract DST and cross-midnight vectors as absolute intervals', () => {
    assertElapsed(parseSlotLink)
  })

  it('keeps two repeated clock readings as distinct instants', () => {
    const first = parseSlotLink(query('2027-11-07T01:30:00-04:00'))
    const second = parseSlotLink(query('2027-11-07T01:30:00-05:00'))
    expect(first).toMatchObject({ status: 'valid', start: '2027-11-07T05:30:00.000Z' })
    expect(second).toMatchObject({ status: 'valid', start: '2027-11-07T06:30:00.000Z' })
    if (first.status === 'valid' && second.status === 'valid')
      expect(wallTime(Date.parse(first.start), 'America/New_York')).toEqual(
        wallTime(Date.parse(second.start), 'America/New_York'),
      )
  })

  it('keeps invitee midnight and date differences without consulting the host zone', () => {
    const parsed = parseSlotLink(query(start, '60'))
    expect(parsed.status).toBe('valid')
    if (parsed.status !== 'valid') return
    expect(dateKeyIn(Date.parse(parsed.start), 'Asia/Tokyo')).toBe('2027-06-15')
    expect(dateKeyIn(Date.parse(parsed.end), 'Asia/Tokyo')).toBe('2027-06-16')
    const different = parseSlotLink(query('2027-06-15T06:30:00.000Z', '60'))
    if (different.status !== 'valid') throw new Error('expected an absolute interval')
    expect(dateKeyIn(Date.parse(different.start), 'Asia/Tokyo')).toBe('2027-06-15')
    expect(dateKeyIn(Date.parse(different.start), 'America/Los_Angeles')).toBe('2027-06-14')
  })
})

function sourceCopy(before?: string, after = ''): typeof parseSlotLink {
  let source = readFileSync('apps/web/src/public/slot-link.ts', 'utf8')
  if (before) {
    expect(source.includes(before), 'source-copy mutation must match').toBe(true)
    source = source.replace(before, after)
  }
  return new Function(
    `${stripTypeScriptTypes(source).replace(/\bexport /g, '')}; return parseSlotLink`,
  )()
}

describe('slot link input source-copy controls', () => {
  it('runs the same assertions on an unmodified source copy', () => {
    assertInputs(sourceCopy())
    assertElapsed(sourceCopy())
  })

  it.each([
    ['percent decoding', "decodeURIComponent(search.replaceAll('+', ' '))", 'void search'],
    ['duplicate pair', 'starts.length !== 1 || durations.length !== 1', 'false'],
    ['UTF-8 link cap', 'new TextEncoder().encode(pathname + search).byteLength > 2048', 'false'],
    ['integer duration spelling', '!/^[1-9]\\d{0,3}$/.test(duration)', 'false'],
    ['maximum duration', 'durationMinutes > 1440', 'false'],
    ['millisecond precision', '(\\d{1,3})', '(\\d{1,9})'],
    ['calendar date', 'day > (monthDays[month - 1] ?? 0)', 'false'],
    ['Gregorian leap year', 'year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)', 'true'],
    ['midnight overflow', 'hour > 23', 'false'],
    ['normalized start year', 'startAt < firstInstant', 'false'],
    ['computed end year', 'endAt > lastInstant', 'false'],
  ])('detects removal of %s', (_name, before, after) => {
    expect(() => assertInputs(sourceCopy(before, after))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('detects incorrect elapsed arithmetic in an isolated source copy', () => {
    expect(() =>
      assertElapsed(sourceCopy('durationMinutes * 60_000', 'durationMinutes * 1000')),
    ).toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })
})
