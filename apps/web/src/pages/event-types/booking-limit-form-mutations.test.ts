import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it } from 'vitest'
import { RequestError } from '../../api/errors.ts'
import * as forms from '../../components/forms.tsx'
import * as translate from '../../i18n/translate.ts'
import * as limits from '../../limits.ts'
import { eventType } from '../../test/fixtures.ts'
import * as text from '../../text.ts'
import type * as Form from './event-type-form.ts'
import * as notifications from './notifications-form.ts'

type Copy = Pick<
  typeof Form,
  | 'emptyDraft'
  | 'validateDraft'
  | 'toPatchInput'
  | 'toInput'
  | 'serverErrors'
  | 'draftFromEventType'
>
function sourceCopy(change?: readonly [string, string]): Copy {
  let source = readFileSync('apps/web/src/pages/event-types/event-type-form.ts', 'utf8')
  if (change) {
    expect(source.includes(change[0])).toBe(true)
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source)
    .replace(/^import[\s\S]*?from '[^']+'\n/gm, '')
    .replace(/\bexport /g, '')
  const bindings = { ...forms, ...translate, ...limits, ...text, ...notifications, RequestError }
  return new Function(
    ...Object.keys(bindings),
    `${source}; return { emptyDraft, validateDraft, toPatchInput, toInput, serverErrors, draftFromEventType }`,
  )(...Object.values(bindings))
}
const cases: { name: string; change: readonly [string, string]; verify: (copy: Copy) => void }[] = [
  ...(['Week', 'Month'] as const).flatMap((period) => {
    const name = `maxBookingsPer${period}` as const
    return [
      {
        name: `${period} integer validation`,
        change: [`['${name}', false],`, ''] as const,
        verify: (copy: Copy) =>
          expect(copy.validateDraft({ ...copy.emptyDraft(), [name]: '1001' })).toHaveProperty(name),
      },
      {
        name: `${period} saved value hydration`,
        change: [`${name}: text(e.${name}),`, `${name}: '',`] as const,
        verify: (copy: Copy) =>
          expect(copy.draftFromEventType(eventType({ [name]: 5 }))).toHaveProperty(name, '5'),
      },
      {
        name: `${period} explicit clearing`,
        change: [`${name}: whole(draft.${name}),`, `${name}: whole(draft.${name}) ?? 1,`] as const,
        verify: (copy: Copy) =>
          expect(
            copy.toPatchInput(copy.emptyDraft(), { ...copy.emptyDraft(), [name]: '5' }),
          ).toHaveProperty(name, null),
      },
      {
        name: `${period} write mapping`,
        change: [`${name}: whole(draft.${name}),`, ''] as const,
        verify: (copy: Copy) =>
          expect(copy.toInput({ ...copy.emptyDraft(), [name]: '5' })).toHaveProperty(name, 5),
      },
    ]
  }),
  {
    name: 'metadata delta preservation',
    change: ['if (whole(draft[name]) === whole(baseline[name])) delete body[name]', ''],
    verify: (copy) => {
      const baseline = { ...copy.emptyDraft(), maxBookingsPerWeek: '5', maxBookingsPerMonth: '10' }
      expect(copy.toPatchInput({ ...baseline, title: 'Renamed' }, baseline)).not.toHaveProperty(
        'maxBookingsPerWeek',
      )
      expect(copy.toPatchInput({ ...baseline, title: 'Renamed' }, baseline)).not.toHaveProperty(
        'maxBookingsPerMonth',
      )
    },
  },
  {
    name: 'period consistency',
    change: ['longerValue < shorterValue', 'false'],
    verify: (copy) =>
      expect(
        copy.validateDraft({
          ...copy.emptyDraft(),
          maxBookingsPerDay: '5',
          maxBookingsPerMonth: '4',
        }),
      ).toHaveProperty('maxBookingsPerMonth'),
  },
  {
    name: 'concurrent booking limit change warning',
    change: ['shorterValue <= longerValue)', 'false)'],
    verify: (copy) =>
      expect(
        copy.serverErrors(
          new RequestError(
            400,
            'invalid_event_type',
            'maxBookingsPerMonth must be at least maxBookingsPerWeek',
          ),
          { ...copy.emptyDraft(), maxBookingsPerWeek: '5', maxBookingsPerMonth: '12' },
        ).fields.maxBookingsPerMonth,
      ).toBe(
        'Booking limits changed elsewhere. Reload to see the current limits before saving again. Your changes have not been saved.',
      ),
  },
  {
    name: 'server consistency error mapping',
    change: ['return field(longer, message)', 'return field(longer, "Wrong message")'],
    verify: (copy) =>
      expect(
        copy.serverErrors(
          new RequestError(
            400,
            'invalid_event_type',
            'maxBookingsPerMonth must be at least maxBookingsPerWeek',
          ),
          { ...copy.emptyDraft(), maxBookingsPerWeek: '20', maxBookingsPerMonth: '12' },
        ).fields.maxBookingsPerMonth,
      ).toBe('Monthly limit must be at least the weekly limit.'),
  },
]
it.each(cases)('detects removal of $name in an isolated source copy', ({ change, verify }) => {
  verify(sourceCopy())
  const mutated = sourceCopy(change)
  expect(() => verify(mutated)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
})
