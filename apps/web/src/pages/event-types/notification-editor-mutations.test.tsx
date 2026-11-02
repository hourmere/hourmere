import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as react from 'react'
import { describe, expect, it } from 'vitest'
import { RequestError } from '../../api/errors.ts'
import {
  describedBy,
  Field,
  FieldError,
  parseWhole,
  wholeNumberProblem,
} from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import { literal, msg } from '../../i18n/translate.ts'
import { EVENT_TYPE, QUESTIONS, RULES } from '../../limits.ts'
import { randomHex } from '../../random.ts'
import styles from '../../styles.css?raw'
import { eventType } from '../../test/fixtures.ts'
import { isMultiLineText, isSingleLineText, singleLineProblem } from '../../text.ts'
import type * as eventFunctions from './event-type-form.ts'
import type { NotificationsEditor } from './NotificationsEditor.tsx'
import * as notificationFunctions from './notifications-form.ts'

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Expected a fixture value')
  return value
}

const helper = readFileSync('apps/web/src/pages/event-types/notifications-form.ts', 'utf8')
const form = readFileSync('apps/web/src/pages/event-types/event-type-form.ts', 'utf8')
const editor = readFileSync('apps/web/src/pages/event-types/NotificationsEditor.tsx', 'utf8')

/** Source copies run real value/DOM assertions before, during and after each mutation. */
function copy<T>(source: string, exported: string, dependencies: Record<string, unknown>): T {
  const compiled = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import {readFileSync} from 'node:fs'; import {transformSync} from 'esbuild'; process.stdout.write(transformSync(readFileSync(0, 'utf8'), {loader:'tsx',format:'cjs',jsxFactory:'react.createElement',jsxFragment:'react.Fragment'}).code)",
    ],
    {
      input: source.replace(/^import[\s\S]*?from '[^']+'$/gm, '').replace(/^export /gm, ''),
      encoding: 'utf8',
    },
  )
  return new Function(...Object.keys(dependencies), `${compiled}; return ${exported}`)(
    ...Object.values(dependencies),
  ) as T
}

function mutate(source: string, before: string, after: string) {
  expect(source.split(before), 'mutation anchor matches once').toHaveLength(2)
  return source.replace(before, after)
}

const helperDeps = {
  RequestError,
  parseWhole,
  wholeNumberProblem,
  literal,
  msg,
  randomHex,
  FOLLOW_UP_HOST_NOTE_MAX_LENGTH: 2000,
}
const buildHelper = (source: string) =>
  copy<typeof notificationFunctions>(
    source,
    '{newNotificationRule, defaultNotificationsDraft, notificationsFromSettings, notificationField, pruneNotificationErrors, normalizedHostNote, notificationsInput, comparableNotifications, validateNotificationsDraft, notificationServerErrors}',
    helperDeps,
  )
const formDeps = {
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
  ...notificationFunctions,
}
const buildForm = (source: string) =>
  copy<typeof eventFunctions>(
    source,
    '{emptyDraft, draftFromEventType, toInput, toPatchInput, validateDraft}',
    formDeps,
  )

function detects(
  source: string,
  before: string,
  after: string,
  assertion: (source: string) => void,
) {
  assertion(source)
  expect(() => assertion(mutate(source, before, after))).toThrowError(
    expect.objectContaining({ name: 'AssertionError' }),
  )
  assertion(source)
}

function Harness({
  Component,
  enabled = true,
  initial = notificationFunctions.defaultNotificationsDraft(),
}: {
  Component: typeof NotificationsEditor
  enabled?: boolean
  initial?: notificationFunctions.NotificationsDraft
}) {
  const [notifications, setNotifications] = react.useState(initial)
  return (
    <>
      <Component
        notifications={notifications}
        errors={{}}
        hostNotesEnabled={enabled}
        onChange={setNotifications}
      />
      <output data-testid="notifications-value">{JSON.stringify(notifications)}</output>
    </>
  )
}

async function assertEditor(
  source: string,
  check: (user: ReturnType<typeof userEvent.setup>) => Promise<void>,
  enabled = true,
  initial?: notificationFunctions.NotificationsDraft,
) {
  const Component = copy<typeof NotificationsEditor>(source, 'NotificationsEditor', {
    react,
    useEffect: react.useEffect,
    useState: react.useState,
    useRef: react.useRef,
    describedBy,
    Field,
    FieldError,
    useI18n,
    msg,
    ...notificationFunctions,
  })
  const view = render(<Harness Component={Component} enabled={enabled} initial={initial} />)
  try {
    await check(userEvent.setup())
  } finally {
    view.unmount()
  }
}

describe('notification editor production-source mutation controls', () => {
  it('detects ambiguous DOM identities for valid saved rule ids', () => {
    detects(
      helper,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: mutate literal production source
      '`notification-${category}-${rule.id}:${part}`',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: restore the previous ambiguous source
      "`notification-${category}-${rule.id}${part === 'id' ? '' : `-${part}`}`",
      (source) => {
        const values = buildHelper(source)
        const first = { ...values.newNotificationRule(60), id: 'x' }
        const second = { ...values.newNotificationRule(30), id: 'x-offsetMinutes' }
        expect(values.notificationField('reminders', first, 'offsetMinutes')).not.toBe(
          values.notificationField('reminders', second, 'id'),
        )
      },
    )
  })
  it.each([
    ['targets.has(id)', 'true', 'row'],
    [
      "if (id === 'notifications' || id.startsWith('notifications.')) return false",
      'if (false) return false',
      'list',
    ],
  ] as const)('detects retaining stale error-summary targets: %s', (before, after, kind) => {
    detects(helper, before, after, (source) => {
      const values = buildHelper(source)
      const removed = values.newNotificationRule(60)
      const survivor = values.newNotificationRule(30)
      const field = values.notificationField('reminders', removed, 'offsetMinutes')
      const errors =
        kind === 'row'
          ? { [field]: 'Enter a whole number.' }
          : {
              notifications: 'Check the form and try again.',
              'notifications.reminders': 'Check the form and try again.',
            }
      expect(
        values.pruneNotificationErrors(errors, { reminders: [survivor], followUps: [] }),
      ).toEqual({})
    })
  })
  it('detects deriving new identities from timing instead of fresh randomness', () => {
    detects(helper, 'randomHex(16)', 'String(offsetMinutes)', (source) => {
      const values = buildHelper(source)
      expect(values.newNotificationRule(60).id).not.toBe(values.newNotificationRule(60).id)
    })
  })

  it('detects sharing editable recipient objects with the saved baseline', () => {
    // The first clone belongs to loading; leave the serializer clone intact.
    detects(
      helper,
      '    recipients: { ...item.recipients },\n  })\n  return { reminders: settings.reminders.map(rule)',
      '    recipients: item.recipients,\n  })\n  return { reminders: settings.reminders.map(rule)',
      (source) => {
        const saved = eventType().notifications
        required(
          buildHelper(source).notificationsFromSettings(saved).reminders[0],
        ).recipients.host = false
        expect(saved.reminders[0]?.recipients.host).toBe(true)
      },
    )
  })

  it.each([
    ['draft[category].length > NOTIFICATION_LIMITS[category]', 'false', 'count'],
    [
      "if (problem) errors[notificationField(category, rule, 'offsetMinutes')] = problem",
      "if (false) errors[notificationField(category, rule, 'offsetMinutes')] = problem",
      'offset',
    ],
    ['offsets.has(minutes)', 'false', 'duplicate'],
    ['!Object.values(rule.recipients).some(Boolean)', 'false', 'recipients'],
    ['note.length > NOTIFICATION_LIMITS.hostNoteMaxLength', 'false', 'length'],
    ['!note.isWellFormed()', 'false', 'unicode'],
  ])('detects weakening notification validation %s', (before, after, kind) => {
    detects(helper, required(before), required(after), (source) => {
      const values = buildHelper(source)
      const first = values.newNotificationRule(60)
      const state = {
        reminders: [first],
        followUps: [] as notificationFunctions.NotificationRuleDraft[],
      }
      if (kind === 'count') state.reminders = [5, 6, 7, 8, 9, 10].map(values.newNotificationRule)
      if (kind === 'offset') first.offsetMinutes = '4'
      if (kind === 'duplicate') state.reminders.push(values.newNotificationRule(60))
      if (kind === 'recipients') first.recipients = { invitee: false, guests: false, host: false }
      if (kind === 'length')
        state.followUps.push({ ...values.newNotificationRule(60), hostNote: '🙂'.repeat(1001) })
      if (kind === 'unicode')
        state.followUps.push({ ...values.newNotificationRule(60), hostNote: '\ud800' })
      expect(Object.keys(values.validateNotificationsDraft(state)).length).toBeGreaterThan(0)
    })
  })

  it('detects accepting forbidden note controls', () => {
    detects(
      helper,
      '/[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f]/.test(note)',
      'false',
      (source) => {
        const values = buildHelper(source)
        const followUp = { ...values.newNotificationRule(60), hostNote: 'Private\tnote' }
        expect(
          values.validateNotificationsDraft({ reminders: [], followUps: [followUp] }),
        ).toHaveProperty(values.notificationField('followUps', followUp, 'hostNote'))
      },
    )
  })

  it.each([
    [".replace(/\\r\\n/g, '\\n')", '', 'First\r\nNext', 'First\nNext'],
    [".replace(/[\\u202a-\\u202e\\u2066-\\u2069]/g, '')", '', 'First\u202eNext', 'FirstNext'],
  ])('detects removing host note normalization %s', (before, after, input, expected) => {
    detects(helper, required(before), required(after), (source) => {
      const values = buildHelper(source)
      expect(
        values.notificationsInput({
          reminders: [],
          followUps: [{ ...values.newNotificationRule(60), hostNote: input }],
        }).followUps[0]?.hostNote,
      ).toBe(expected)
    })
  })

  it('detects mapping a server error to a different row', () => {
    detects(helper, 'rules?.[Number(index)]', 'rules?.[0]', (source) => {
      const values = buildHelper(source)
      const state = {
        reminders: [values.newNotificationRule(1440), values.newNotificationRule(30)],
        followUps: [],
      }
      const errors = values.notificationServerErrors(
        new RequestError(
          400,
          'invalid_notifications',
          'notifications.reminders[1].recipients: at least one recipient must be selected',
        ),
        state,
      )
      expect(errors).toHaveProperty(
        values.notificationField('reminders', required(state.reminders[1]), 'recipients'),
      )
    })
  })

  it('detects leaking default settings into untouched create payloads', () => {
    detects(
      form,
      'comparableNotifications(defaultNotificationsDraft()) && {',
      "'different' && {",
      (source) => {
        const values = buildForm(source)
        expect(values.toInput(values.emptyDraft())).not.toHaveProperty('notifications')
      },
    )
  })

  it('detects replacing concurrent API notification changes during metadata saves', () => {
    detects(
      form,
      'delete body.notifications',
      'body.notifications = notificationsInput(draft.notifications)',
      (source) => {
        const values = buildForm(source)
        const saved = eventType()
        saved.notifications.followUps.push({
          id: 'saved-follow-up',
          offsetMinutes: 60,
          recipients: { invitee: true, guests: false, host: false },
        })
        const baseline = values.draftFromEventType(saved)
        expect(values.toPatchInput({ ...baseline, title: 'Renamed' }, baseline)).not.toHaveProperty(
          'notifications',
        )
      },
    )
  })

  it('detects dropping an explicit change from custom settings back to defaults', () => {
    detects(
      form,
      'else body.notifications = notificationsInput(draft.notifications)',
      'else delete body.notifications',
      (source) => {
        const values = buildForm(source)
        const baseline = { ...values.emptyDraft(), notifications: { reminders: [], followUps: [] } }
        expect(values.toPatchInput(values.emptyDraft(), baseline).notifications).toEqual(
          eventType().notifications,
        )
      },
    )
  })

  it('detects validating untouched legacy notes during a metadata save', () => {
    detects(
      form,
      'comparableNotifications(baseline?.notifications ?? defaultNotificationsDraft())\n  )',
      "'always-different'\n  )",
      (source) => {
        const values = buildForm(source)
        const saved = eventType()
        saved.notifications.followUps.push({
          id: 'legacy-note',
          offsetMinutes: 60,
          recipients: { invitee: true, guests: false, host: false },
          hostNote: 'Old\tnote',
        })
        const baseline = values.draftFromEventType(saved)
        expect(values.validateDraft({ ...baseline, title: 'Renamed' }, baseline)).toEqual({})
      },
    )
  })

  it('detects showing note editing while the operator switch is off', async () => {
    const check = async () => {
      expect(screen.queryByLabelText('Host note (optional)')).toBeNull()
      expect(screen.getByRole('button', { name: 'Remove saved host note' })).toBeDefined()
    }
    const initial = {
      reminders: [],
      followUps: [
        { ...notificationFunctions.newNotificationRule(60), hostNote: 'Saved private note' },
      ],
    }
    await assertEditor(editor, check, false, initial)
    await expect(
      assertEditor(mutate(editor, 'hostNotesEnabled ? (', 'true ? ('), check, false, initial),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await assertEditor(editor, check, false, initial)
  })

  it('detects failing to delete a saved note through the explicit action', async () => {
    const check = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole('button', { name: 'Remove saved host note' }))
      const state = JSON.parse(
        required(screen.getByTestId('notifications-value').textContent),
      ) as notificationFunctions.NotificationsDraft
      expect(notificationFunctions.notificationsInput(state).followUps[0]).not.toHaveProperty(
        'hostNote',
      )
    }
    const initial = {
      reminders: [],
      followUps: [
        { ...notificationFunctions.newNotificationRule(60), hostNote: 'Saved private note' },
      ],
    }
    await assertEditor(editor, check, false, initial)
    await expect(
      assertEditor(
        mutate(editor, "update(category, rule.id, { hostNote: '' })", 'void 0'),
        check,
        false,
        initial,
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await assertEditor(editor, check, false, initial)
  })

  it('detects silencing add/remove announcements', async () => {
    const check = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole('button', { name: 'Add reminder' }))
      await waitFor(() =>
        expect(
          within(screen.getByRole('region', { name: 'Reminders and follow-ups' })).getByRole(
            'status',
          ).textContent,
        ).toBe('Added reminder 2.'),
      )
    }
    await assertEditor(editor, check)
    await expect(
      assertEditor(
        mutate(
          editor,
          'setTimeout(() => setAnnouncement(message), 0)',
          "setTimeout(() => setAnnouncement(''), 0)",
        ),
        check,
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await assertEditor(editor, check)
  })

  it('detects failing to refresh the announcement node for successive actions', async () => {
    const check = async (user: ReturnType<typeof userEvent.setup>) => {
      const add = screen.getByRole('button', { name: 'Add reminder' })
      const status = within(
        screen.getByRole('region', { name: 'Reminders and follow-ups' }),
      ).getByRole('status')
      await user.click(add)
      await waitFor(() => expect(status.textContent).toBe('Added reminder 2.'))
      await user.click(screen.getByRole('button', { name: 'Remove reminder 2' }))
      await waitFor(() => expect(status.textContent).toBe('Removed reminder 2.'))
      await user.click(add)
      await waitFor(() => expect(status.textContent).toBe('Added reminder 2.'))
      const announcements: (string | null)[] = []
      const observer = new MutationObserver(() => announcements.push(status.textContent))
      observer.observe(status, { childList: true, characterData: true, subtree: true })
      try {
        await user.click(screen.getByRole('button', { name: 'Remove reminder 2' }))
        await waitFor(() => expect(announcements).toContain('Removed reminder 2.'))
        expect(announcements).toContain('')
      } finally {
        observer.disconnect()
      }
    }
    await assertEditor(editor, check)
    await expect(
      assertEditor(mutate(editor, "    setAnnouncement('')\n", ''), check),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await assertEditor(editor, check)
  })

  it.each([
    ['  min-width: 0;', '  min-width: 320px;', '.notifications-editor', 'min-width', '0px'],
    [
      '  flex-wrap: wrap;',
      '  flex-wrap: nowrap;',
      '.notification-recipients > div',
      'flex-wrap',
      'wrap',
    ],
    [
      '  white-space: normal;',
      '  white-space: nowrap;',
      '.notification-card > .button',
      'white-space',
      'normal',
    ],
  ])(
    'detects a 320px notification layout regression %s',
    (before, after, selector, property, expected) => {
      const css = styles.slice(styles.indexOf('/* Notification rules stack'))
      detects(css, required(before), required(after), (source) => {
        const style = document.createElement('style')
        style.textContent = source
        document.head.append(style)
        const view = render(
          <section className="notifications-editor">
            <fieldset className="notification-card">
              <div className="notification-recipients">
                <div />
              </div>
              <button type="button" className="button">
                Remove follow-up
              </button>
            </fieldset>
          </section>,
        )
        try {
          expect(
            getComputedStyle(required(document.querySelector(required(selector)))).getPropertyValue(
              required(property),
            ),
          ).toBe(expected)
        } finally {
          view.unmount()
          style.remove()
        }
      })
    },
  )
})
