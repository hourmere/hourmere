import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RequestError } from '../../api/errors.ts'
import { parseWhole, wholeNumberProblem } from '../../components/forms.tsx'
import { literal, msg } from '../../i18n/translate.ts'
import { EVENT_TYPE, QUESTIONS, RULES } from '../../limits.ts'
import { eventType } from '../../test/fixtures.ts'
import { isMultiLineText, isSingleLineText, singleLineProblem } from '../../text.ts'
import type * as formFunctions from './event-type-form.ts'
import * as notificationFunctions from './notifications-form.ts'

const form = readFileSync('apps/web/src/pages/event-types/event-type-form.ts', 'utf8')

/** Execute only source copies, keeping production files restored throughout each control. */
function buildForm(source: string): typeof formFunctions {
  const compiled = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import {readFileSync} from 'node:fs'; import {transformSync} from 'esbuild'; process.stdout.write(transformSync(readFileSync(0, 'utf8'), {loader:'ts',format:'cjs'}).code)",
    ],
    {
      input: source.replace(/^import[\s\S]*?from '[^']+'$/gm, '').replace(/^export /gm, ''),
      encoding: 'utf8',
    },
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
    `${compiled}; return {emptyDraft, draftFromEventType, validateDraft, toInput, toPatchInput}`,
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
  it('detects forgetting that the saved phone is supplied by the invitee', () => {
    detects(
      "phoneAskInvitee: location?.kind === 'phone' && location.askInvitee === true,",
      'phoneAskInvitee: false,',
      (values) => {
        const baseline = values.draftFromEventType(
          eventType({ location: { kind: 'phone', askInvitee: true } }),
        )
        expect(values.toInput(baseline).location).toEqual({ kind: 'phone', askInvitee: true })
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
        expect(values.toInput(baseline).location).toEqual({ kind: 'phone', askInvitee: true })
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
