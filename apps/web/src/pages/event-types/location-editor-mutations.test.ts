import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RequestError } from '../../api/errors.ts'
import { parseWhole, wholeNumberProblem } from '../../components/forms.tsx'
import { literal, msg } from '../../i18n/translate.ts'
import { EVENT_TYPE, QUESTIONS, RULES } from '../../limits.ts'
import { compileSourceCopy } from '../../test/compile-source-copy.ts'
import { eventType } from '../../test/fixtures.ts'
import { isMultiLineText, isSingleLineText, singleLineProblem } from '../../text.ts'
import type * as formFunctions from './event-type-form.ts'
import * as notificationFunctions from './notifications-form.ts'

const form = readFileSync('apps/web/src/pages/event-types/event-type-form.ts', 'utf8')

/** Execute only source copies, keeping production files restored throughout each control. */
function buildForm(source: string): typeof formFunctions {
  const compiled = compileSourceCopy(
    'apps/web/src/pages/event-types/event-type-form.ts',
    source.replace(/^import[\s\S]*?from '[^']+'$/gm, '').replace(/^export /gm, ''),
    { loader: 'ts', format: 'cjs' },
  )
  const dependencies = {
    ...notificationFunctions,
    RequestError,
    parseWhole,
    wholeNumberProblem,
    literal,
    msg,
    EVENT_TYPE,
    QUESTIONS,
    RULES,
    isMultiLineText,
    isSingleLineText,
    singleLineProblem,
  }
  return new Function(
    ...Object.keys(dependencies),
    `${compiled}; return {changeLocationKind, emptyDraft, draftFromEventType, validateDraft, toInput, toPatchInput, serverErrors}`,
  )(...Object.values(dependencies)) as typeof formFunctions
}

function detects(before: string, after: string, assertion: (values: typeof formFunctions) => void) {
  expect(form.split(before), 'mutation anchor matches once').toHaveLength(2)
  assertion(buildForm(form))
  expect(() => assertion(buildForm(form.replace(before, after)))).toThrowError(
    expect.objectContaining({ name: 'AssertionError' }),
  )
  assertion(buildForm(form))
}

describe('location editor production-source mutation controls', () => {
  it('detects adding a derived durations error for an invalid first-screen duration', () => {
    detects(
      '!wholeNumberProblem(defaultDuration, RULES.durationMinutes, true) &&',
      'true &&',
      (values) => {
        const draft = {
          ...values.emptyDraft(),
          title: 'Intro',
          slug: 'intro',
          durationMinutes: '2000',
        }
        expect(Object.keys(values.validateDraft(draft))).toEqual(['durationMinutes'])
      },
    )
  })
  it('detects sending primary invitee collection through the rejected legacy path', () => {
    detects(
      "draft.locationOptions === null && !(location?.kind === 'phone' && location.askInvitee)",
      'draft.locationOptions === null',
      (values) => {
        const draft = {
          ...values.emptyDraft(),
          locationKind: 'phone' as const,
          phoneAskInvitee: true,
        }
        expect(values.toInput(draft).locations).toEqual([
          { id: draft.primaryLocationId, kind: 'phone', askInvitee: true },
        ])
        expect(values.toInput(draft)).not.toHaveProperty('location')
      },
    )
  })
  it('detects dropping a named primary while changing another location', () => {
    detects('            ...(option.label && { label: option.label }),', '', (values) => {
      const baseline = values.draftFromEventType(
        eventType({
          location: { kind: 'phone', askInvitee: true },
          locations: [
            { id: 'call', kind: 'phone', askInvitee: true, label: 'Call me', isDefault: true },
            { id: 'office', kind: 'in_person', address: '1 Main Street' },
          ],
        }),
      )
      const draft = {
        ...baseline,
        locationOptions: (baseline.locationOptions ?? []).map((option) =>
          option.id === 'office' ? { ...option, address: '2 Main Street' } : option,
        ),
      }
      expect(values.toPatchInput(draft, baseline).locations?.[0]).toEqual({
        id: 'call',
        kind: 'phone',
        askInvitee: true,
        label: 'Call me',
        isDefault: true,
      })
    })
  })

  it('detects clearing collective host schedules on a metadata save', () => {
    detects(
      "if (draft.schedulingType !== 'individual' && sameHosts) delete body.scheduleId",
      "if (draft.schedulingType === 'round_robin' && sameHosts) delete body.scheduleId",
      (values) => {
        const baseline = {
          ...values.emptyDraft(),
          schedulingType: 'collective' as const,
          hostUserIds: ['host-one', 'host-two'],
        }
        expect(
          values.toPatchInput({ ...baseline, title: 'Renamed panel' }, baseline),
        ).not.toHaveProperty('scheduleId')
      },
    )
  })

  it('detects displaying a location conflict as untranslated server prose', () => {
    detects("case 'location_options_conflict':", "case 'unused_location_conflict':", (values) => {
      const result = values.serverErrors(
        new RequestError(409, 'location_options_conflict', 'Raw server detail.'),
        values.emptyDraft(),
      )
      expect(result.message).toEqual(
        msg(
          'The saved location options cannot be changed here. Keep the location unchanged and try again.',
        ),
      )
    })
  })
  it('detects forgetting that the saved phone is supplied by the invitee', () => {
    detects(
      "phoneAskInvitee: location?.kind === 'phone' && location.askInvitee === true,",
      'phoneAskInvitee: false,',
      (values) => {
        const baseline = values.draftFromEventType(
          eventType({ location: { kind: 'phone', askInvitee: true } }),
        )
        expect(values.toInput(baseline).locations).toEqual([
          { id: baseline.primaryLocationId, kind: 'phone', askInvitee: true },
        ])
      },
    )
  })

  it('detects blocking an untouched invitee-phone value as an empty host number', () => {
    detects(
      "        !(draft.phoneAskInvitee && draft.phone.trim() === '') &&",
      '        true &&',
      (values) => {
        const baseline = values.draftFromEventType(
          eventType({ location: { kind: 'phone', askInvitee: true } }),
        )
        expect(values.validateDraft({ ...baseline, title: 'Renamed' }, baseline)).toEqual({})
      },
    )
  })

  it('detects skipping validation after the host starts entering a phone number', () => {
    detects(
      "        !(draft.phoneAskInvitee && draft.phone.trim() === '') &&",
      '        !draft.phoneAskInvitee &&',
      (values) => {
        const baseline = values.draftFromEventType(
          eventType({ location: { kind: 'phone', askInvitee: true } }),
        )
        expect(values.validateDraft({ ...baseline, phone: '0301234567' }, baseline)).toHaveProperty(
          'location-phone',
        )
      },
    )
  })

  it('detects serializing invitee phone as an empty host number', () => {
    detects(
      "return draft.phoneAskInvitee && draft.phone.trim() === ''",
      'return false',
      (values) => {
        const baseline = values.draftFromEventType(
          eventType({ location: { kind: 'phone', askInvitee: true } }),
        )
        expect(values.toInput(baseline).locations).toEqual([
          { id: baseline.primaryLocationId, kind: 'phone', askInvitee: true },
        ])
      },
    )
  })

  it('detects resending an unchanged compat location during a metadata save', () => {
    detects(
      'if (JSON.stringify(body.location) === JSON.stringify(toInput(baseline).location))\n    delete body.location',
      'void 0',
      (values) => {
        const baseline = values.draftFromEventType(
          eventType({ location: { kind: 'phone', number: '+14155550123' } }),
        )
        expect(values.toPatchInput({ ...baseline, title: 'Renamed' }, baseline)).not.toHaveProperty(
          'location',
        )
      },
    )
  })

  it('detects dropping a deliberate location change from the patch', () => {
    detects(
      'JSON.stringify(body.location) === JSON.stringify(toInput(baseline).location)',
      'true',
      (values) => {
        const baseline = values.draftFromEventType(
          eventType({ location: { kind: 'phone', askInvitee: true } }),
        )
        expect(
          values.toPatchInput({ ...baseline, phone: '+14155550123' }, baseline).location,
        ).toEqual({ kind: 'phone', number: '+14155550123' })
      },
    )
  })
})

describe('ordered locations editor preservation controls', () => {
  const options = [
    { id: 'office', kind: 'in_person' as const, address: '42 Main Street', label: 'Office' },
    { id: 'call', kind: 'phone' as const, askInvitee: true as const, isDefault: true as const },
  ]
  it('loads and preserves every option and its metadata', () => {
    detects(
      'locationOptions: e.locations?.map((option) => ({ ...option })) ?? null,',
      'locationOptions: null,',
      (values) => {
        const baseline = values.draftFromEventType(
          eventType({ locations: options, location: { kind: 'phone', askInvitee: true } }),
        )
        expect(values.toInput(baseline).locations).toEqual(options)
        expect(values.toPatchInput({ ...baseline, title: 'Renamed' }, baseline)).not.toHaveProperty(
          'locations',
        )
        expect(values.toPatchInput({ ...baseline, title: 'Renamed' }, baseline)).not.toHaveProperty(
          'location',
        )
      },
    )
  })
  it('updates the selected primary option without replacing other options', () => {
    detects(
      'if (option.id !== draft.primaryLocationId) return [option]',
      'if (false) return [option]',
      (values) => {
        const baseline = values.draftFromEventType(
          eventType({ locations: options, location: { kind: 'phone', askInvitee: true } }),
        )
        const changed = { ...baseline, phone: '+14155550123' }
        expect(values.toPatchInput(changed, baseline).locations).toEqual([
          options[0],
          { id: 'call', kind: 'phone', number: '+14155550123', isDefault: true },
        ])
      },
    )
  })
  it('sends reordered options and preserves their stable identities', () => {
    detects('    delete body.locations', '    body.locations = null', (values) => {
      const baseline = values.draftFromEventType(
        eventType({ locations: options, location: { kind: 'phone', askInvitee: true } }),
      )
      expect(values.toPatchInput({ ...baseline, title: 'Changed' }, baseline)).not.toHaveProperty(
        'locations',
      )
      expect(
        values.toPatchInput({ ...baseline, locationOptions: [...options].reverse() }, baseline)
          .locations,
      ).toEqual([...options].reverse())
    })
  })
  it('rejects invalid fields on additional location options', () => {
    detects("if (option.kind === 'link') add", 'if (false) add', (values) => {
      const draft = {
        ...values.emptyDraft(),
        title: 'Intro',
        slug: 'intro',
        locationKind: 'google_meet' as const,
        locationOptions: [{ id: 'bad-link', kind: 'link' as const, url: 'not-a-url' }],
      }
      expect(values.validateDraft(draft)).toHaveProperty('location-option-bad-link-value')
    })
  })
  it('allocates fresh identity on replacing or removing and readding a primary choice', () => {
    detects(
      'primaryLocationId: id, locationOptions: options',
      'primaryLocationId: draft.primaryLocationId, locationOptions: options',
      (values) => {
        const baseline = values.draftFromEventType(
          eventType({ locations: options, location: { kind: 'phone', askInvitee: true } }),
        )
        const replaced = values.changeLocationKind(baseline, 'zoom')
        expect(replaced.primaryLocationId).not.toBe(baseline.primaryLocationId)
        expect(values.toInput(replaced).locations).toEqual([
          options[0],
          { id: replaced.primaryLocationId, kind: 'zoom', isDefault: true },
        ])
        const removed = values.changeLocationKind(baseline, '')
        const readded = values.changeLocationKind(removed, 'phone')
        expect(readded.primaryLocationId).not.toBe(baseline.primaryLocationId)
      },
    )
  })
})
