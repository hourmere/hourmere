import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as react from 'react'
import { describe, expect, it } from 'vitest'
import { RequestError } from '../../api/errors.ts'
import { Field, FieldError, parseWhole, wholeNumberProblem } from '../../components/forms.tsx'
import { formatMinutes } from '../../i18n/duration.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { literal, msg } from '../../i18n/translate.ts'
import { EVENT_TYPE, QUESTIONS, RULES } from '../../limits.ts'
import styles from '../../styles.css?raw'
import { eventType } from '../../test/fixtures.ts'
import { isMultiLineText, isSingleLineText, singleLineProblem } from '../../text.ts'
import type { DurationsEditor } from './DurationsEditor.tsx'
import * as formFunctions from './event-type-form.ts'
import * as notificationFunctions from './notifications-form.ts'

const form = readFileSync('apps/web/src/pages/event-types/event-type-form.ts', 'utf8')
const editor = readFileSync('apps/web/src/pages/event-types/DurationsEditor.tsx', 'utf8')

/** Execute source copies; each mutant must fail a real state or DOM assertion. */
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

const formDeps = {
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
const buildForm = (source: string) =>
  copy<typeof formFunctions>(
    source,
    '{durationToAddProblem, allowedDurationsProblem, draftFromEventType, toInput, toPatchInput, emptyDraft, serverErrors}',
    formDeps,
  )

function detects(before: string, after: string, assertion: (source: string) => void) {
  assertion(form)
  expect(() => assertion(mutate(form, before, after))).toThrowError(
    expect.objectContaining({ name: 'AssertionError' }),
  )
  assertion(form)
}

function MutationHarness({ Component }: { Component: typeof DurationsEditor }) {
  const [durations, setDurations] = react.useState([30, 45])
  const [duration, setDuration] = react.useState('30')
  return (
    <>
      <Component
        durations={durations}
        defaultDuration={duration}
        errors={{}}
        onDefaultChange={setDuration}
        onChange={(values, selected) => {
          setDurations(values)
          setDuration(selected)
        }}
      />
      <output data-testid="selected-default">{duration}</output>
    </>
  )
}

describe('duration editor production-source mutation controls', () => {
  it('detects bypassing numeric bounds and integer validation on add', () => {
    detects('if (problem) return problem', 'if (false) return problem', (source) => {
      const value = buildForm(source)
      for (const invalid of ['0', '1441', '1.5'])
        expect(value.durationToAddProblem(invalid, [30])).not.toBeNull()
      expect(value.durationToAddProblem('1', [30])).toBeNull()
      expect(value.durationToAddProblem('1440', [30])).toBeNull()
    })
  })

  it.each([
    ['durations.includes(parseWhole(value) as number)', 'false', '30', [30]],
    [
      'durations.length >= EVENT_TYPE.maxAllowedDurations',
      'false',
      '30',
      Array.from({ length: 12 }, (_, i) => i + 1),
    ],
  ] as const)('detects weakening add protection %s', (before, after, value, durations) => {
    detects(before, after, (source) => {
      expect(buildForm(source).durationToAddProblem(value, [...durations])).not.toBeNull()
    })
  })

  it.each([
    ['durations.length < 1', 'false', [], '30'],
    [
      'durations.length > EVENT_TYPE.maxAllowedDurations',
      'false',
      Array.from({ length: 13 }, (_, i) => i + 1),
      '1',
    ],
    ['!Number.isInteger(value)', 'false', [1.5, 30], '30'],
    ['value < RULES.durationMinutes.min', 'false', [0, 30], '30'],
    ['value > RULES.durationMinutes.max', 'false', [30, 1441], '30'],
    ['new Set(durations).size !== durations.length', 'false', [30, 30], '30'],
    ['!durations.includes(parseWhole(defaultDuration) as number)', 'false', [15, 60], '30'],
  ] as const)(
    'detects weakening stored-list protection %s',
    (before, after, durations, defaultDuration) => {
      detects(before, after, (source) => {
        const problem = buildForm(source).allowedDurationsProblem([...durations], defaultDuration)
        if (durations.length === 0) expect(problem).toBe('Offer from 1 to 12 durations.')
        else expect(problem).not.toBeNull()
      })
    },
  )

  it('detects losing offered lengths when loading an existing event', () => {
    detects('[...e.allowedDurationsMinutes]', '[e.durationMinutes]', (source) => {
      expect(
        buildForm(source).draftFromEventType(eventType({ allowedDurationsMinutes: [15, 30, 60] }))
          .allowedDurationsMinutes,
      ).toEqual([15, 30, 60])
    })
  })

  it('detects losing offered lengths in create and patch serialization', () => {
    detects('[...draft.allowedDurationsMinutes]', '[Number(draft.durationMinutes)]', (source) => {
      const values = buildForm(source)
      expect(
        values.toInput({ ...values.emptyDraft(), allowedDurationsMinutes: [15, 30, 60] })
          .allowedDurationsMinutes,
      ).toEqual([15, 30, 60])
    })
  })

  it('detects adding an unnecessary singleton list to a create payload', () => {
    detects('draft.allowedDurationsMinutes.length > 1', 'true', (source) => {
      const values = buildForm(source)
      expect(values.toInput(values.emptyDraft())).not.toHaveProperty('allowedDurationsMinutes')
    })
  })

  it('detects overwriting an unchanged multi-duration list on metadata saves', () => {
    detects('delete body.allowedDurationsMinutes', 'void 0', (source) => {
      const values = buildForm(source)
      const baseline = { ...values.emptyDraft(), allowedDurationsMinutes: [15, 30, 60] }
      expect(values.toPatchInput({ ...baseline, title: 'Renamed' }, baseline)).not.toHaveProperty(
        'allowedDurationsMinutes',
      )
    })
  })

  it('detects dropping an explicitly reduced singleton list from a patch', () => {
    detects(
      'body.allowedDurationsMinutes = draft.allowedDurationsMinutes.slice()',
      'delete body.allowedDurationsMinutes',
      (source) => {
        const values = buildForm(source)
        const baseline = { ...values.emptyDraft(), allowedDurationsMinutes: [15, 30, 60] }
        expect(
          values.toPatchInput({ ...baseline, allowedDurationsMinutes: [30] }, baseline)
            .allowedDurationsMinutes,
        ).toEqual([30])
      },
    )
  })

  it('detects dropping the localized server membership refusal', () => {
    detects("detail.includes('include durationMinutes')", 'false', (source) => {
      const values = buildForm(source)
      expect(
        values.serverErrors(
          new RequestError(
            400,
            'invalid_event_type',
            'allowedDurationsMinutes must include durationMinutes',
          ),
          values.emptyDraft(),
        ).fields,
      ).toEqual({
        allowedDurationsMinutes: 'Include the default duration in the allowed durations.',
      })
    })
  })

  it('detects replacing saved notification policies during duration edits', () => {
    detects(
      'allowedDurationsMinutes: [...draft.allowedDurationsMinutes],',
      'allowedDurationsMinutes: [...draft.allowedDurationsMinutes], notifications: { reminders: [], followUps: [] },',
      (source) => {
        const values = buildForm(source)
        expect(
          values.toInput({ ...values.emptyDraft(), allowedDurationsMinutes: [15, 30, 60] }),
        ).not.toHaveProperty('notifications')
      },
    )
  })

  it('detects removing the final-duration handler guard', () => {
    const removal = editor.slice(editor.indexOf('  function remove('), editor.indexOf('  return ('))
    function assertion(source: string) {
      let result = [30]
      const remove = copy<(minutes: number) => void>(source, 'remove', {
        durations: [30],
        defaultDuration: '30',
        onChange: (values: number[]) => {
          result = values
        },
        setError: () => {},
        announce: () => {},
        msg,
        length: String,
        defaultSelect: { current: null },
      })
      remove(30)
      expect(result).toEqual([30])
    }
    assertion(removal)
    expect(() =>
      assertion(mutate(removal, 'if (durations.length <= 1) return', 'if (false) return')),
    ).toThrowError(expect.objectContaining({ name: 'AssertionError' }))
    assertion(removal)
  })

  it.each([
    ['  min-width: 0;', '  min-width: 320px;', '.durations-editor', 'min-width', '0px'],
    ['  flex-wrap: wrap;', '  flex-wrap: nowrap;', '.duration-presets', 'flex-wrap', 'wrap'],
  ])(
    'detects narrow-editor layout regression %s',
    (before, after, selector, property, expected) => {
      const css = styles.slice(styles.indexOf('/* Length controls wrap'))
      // Limit a mutation to the relevant declaration's first occurrence.
      const index = css.indexOf(before)
      expect(index).toBeGreaterThan(0)
      function assertion(source: string) {
        const style = document.createElement('style')
        style.textContent = source
        document.head.append(style)
        const view = render(
          <fieldset className="durations-editor">
            <fieldset className="duration-presets" />
          </fieldset>,
        )
        try {
          expect(
            getComputedStyle(document.querySelector(selector) as Element).getPropertyValue(
              property,
            ),
          ).toBe(expected)
        } finally {
          view.unmount()
          style.remove()
        }
      }
      assertion(css)
      expect(() =>
        assertion(css.slice(0, index) + css.slice(index).replace(before, after)),
      ).toThrowError(expect.objectContaining({ name: 'AssertionError' }))
      assertion(css)
    },
  )

  async function assertEditor(
    source: string,
    check: (user: ReturnType<typeof userEvent.setup>) => Promise<void>,
  ) {
    const Component = copy<typeof DurationsEditor>(source, 'DurationsEditor', {
      react,
      useEffect: react.useEffect,
      useRef: react.useRef,
      useState: react.useState,
      Field,
      FieldError,
      formatMinutes,
      useI18n,
      msg,
      EVENT_TYPE,
      durationToAddProblem: formFunctions.durationToAddProblem,
    })
    const view = render(<MutationHarness Component={Component} />)
    try {
      await check(userEvent.setup())
    } finally {
      view.unmount()
    }
  }

  it.each([
    {
      before: 'Number(defaultDuration) === minutes',
      after: 'false',
      check: async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(screen.getByRole('button', { name: 'Remove 30 min' }))
        expect(screen.getByTestId('selected-default').textContent).toBe('45')
      },
    },
    {
      before: 'disabled={durations.length <= 1}',
      after: 'disabled={false}',
      check: async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(screen.getByRole('button', { name: 'Remove 30 min' }))
        expect(
          within(
            screen.getByRole('list', { name: 'Offered lengths' }),
          ).getByRole<HTMLButtonElement>('button').disabled,
        ).toBe(true)
      },
    },
    {
      before: 'defaultSelect.current?.focus()',
      after: 'void 0',
      check: async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(screen.getByRole('button', { name: 'Remove 30 min' }))
        expect(document.activeElement).toBe(screen.getByLabelText('Default duration'))
      },
    },
    {
      before: '[...durations, minutes].sort((a, b) => a - b)',
      after: 'durations',
      check: async (user: ReturnType<typeof userEvent.setup>) => {
        await user.type(screen.getByLabelText('Duration to add (minutes)'), '75{Enter}')
        expect(
          within(screen.getByRole('list', { name: 'Offered lengths' })).getAllByRole('listitem'),
        ).toHaveLength(3)
      },
    },
  ])('detects weakening editor state/focus: $before', async ({ before, after, check }) => {
    await assertEditor(editor, check)
    await expect(assertEditor(mutate(editor, before, after), check)).rejects.toMatchObject({
      name: 'AssertionError',
    })
    await assertEditor(editor, check)
  })

  it('detects silently rejecting a duplicate added with Enter', async () => {
    const check = async (user: ReturnType<typeof userEvent.setup>) => {
      const input = screen.getByLabelText('Duration to add (minutes)')
      const status = within(screen.getByRole('group', { name: 'Allowed durations' })).getByRole(
        'status',
      )
      await user.type(input, '30{Enter}')
      await waitFor(() => expect(status.textContent).toBe('This duration is already in the list.'))
      expect(document.activeElement).toBe(input)
    }
    await assertEditor(editor, check)
    await expect(
      assertEditor(mutate(editor, 'announce(problem)', 'void 0'), check),
    ).rejects.toMatchObject({
      name: 'AssertionError',
    })
    await assertEditor(editor, check)
  })

  it('detects failing to re-announce an identical Enter error', async () => {
    const check = async (user: ReturnType<typeof userEvent.setup>) => {
      const input = screen.getByLabelText('Duration to add (minutes)')
      const status = within(screen.getByRole('group', { name: 'Allowed durations' })).getByRole(
        'status',
      )
      const message = 'This duration is already in the list.'
      await user.type(input, '30{Enter}')
      await waitFor(() => expect(status.textContent).toBe(message))
      const announcements: (string | null)[] = []
      const observer = new MutationObserver(() => announcements.push(status.textContent))
      observer.observe(status, { childList: true, characterData: true, subtree: true })
      try {
        await user.keyboard('{Enter}')
        await waitFor(() => expect(announcements).toContain(message))
        expect(announcements).toContain('')
        expect(document.activeElement).toBe(input)
      } finally {
        observer.disconnect()
      }
    }
    const before = "    setAnnouncement('')\n    announcementTimer.current = setTimeout"
    const after = '    announcementTimer.current = setTimeout'
    await assertEditor(editor, check)
    await expect(assertEditor(mutate(editor, before, after), check)).rejects.toMatchObject({
      name: 'AssertionError',
    })
    await assertEditor(editor, check)
  })
})
