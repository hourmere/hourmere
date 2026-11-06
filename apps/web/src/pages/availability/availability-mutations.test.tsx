import '../../i18n/admin.ts'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as react from 'react'
import * as router from 'react-router'
import { describe, expect, it } from 'vitest'
import * as client from '../../api/client.ts'
import * as errors from '../../api/errors.ts'
import { ConfirmAction } from '../../components/ConfirmAction.tsx'
import * as forms from '../../components/forms.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { TimeZonePicker } from '../../components/TimeZonePicker.tsx'
import * as flash from '../../flash.ts'
import * as hooks from '../../hooks.ts'
import { InterfaceScope, useI18n } from '../../i18n/runtime.tsx'
import * as translate from '../../i18n/translate.ts'
import * as paths from '../../paths.ts'
import { fakeApi, json } from '../../test/fake-api.tsx'
import { SCHEDULE_ID, schedule } from '../../test/fixtures.ts'
import * as unsaved from '../../unsaved-changes.tsx'
import { CopyDay } from './CopyDay.tsx'
import { IntervalsEditor } from './IntervalsEditor.tsx'
import * as overrides from './Overrides.tsx'
import * as hours from './weekly-hours.ts'

const weeklySource = readFileSync('apps/web/src/pages/availability/weekly-hours.ts', 'utf8')
const editorSource = readFileSync('apps/web/src/pages/availability/ScheduleEditor.tsx', 'utf8')
const formSource = editorSource.slice(editorSource.indexOf('function ScheduleForm('))
const dependencies = {
  ...react,
  ...router,
  ...client,
  ...errors,
  ...forms,
  ...flash,
  ...hooks,
  ...translate,
  ...paths,
  ...unsaved,
  ...overrides,
  ...hours,
  ConfirmAction,
  PageHeader,
  TimeZonePicker,
  useI18n,
  CopyDay,
  IntervalsEditor,
}

/** Compile an in-memory source copy; production files are never changed by mutation checks. */
function copy<T>(source: string, name: string): T {
  const compiled = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import {readFileSync} from 'node:fs';import {transformSync} from 'esbuild';process.stdout.write(transformSync(readFileSync(0,'utf8'),{loader:'tsx',format:'cjs',jsxFactory:'reactRuntime.createElement',jsxFragment:'reactRuntime.Fragment'}).code)",
    ],
    { input: source.replace(/^export /gm, ''), encoding: 'utf8' },
  )
  return new Function(
    'reactRuntime',
    ...Object.keys(dependencies).filter(
      (key) => key !== name && key !== 'default' && /^[A-Za-z_$][\w$]*$/.test(key),
    ),
    `${compiled}; return ${name}`,
  )(
    react,
    ...Object.entries(dependencies)
      .filter(([key]) => key !== name && key !== 'default' && /^[A-Za-z_$][\w$]*$/.test(key))
      .map(([, value]) => value),
  ) as T
}
async function detects(
  source: string,
  before: string,
  after: string,
  assertion: (source: string) => void | Promise<void>,
) {
  expect(source.split(before)).toHaveLength(2)
  await assertion(source)
  cleanup()
  let failure: unknown
  try {
    await assertion(source.replace(before, after))
  } catch (error) {
    failure = error
  } finally {
    cleanup()
  }
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).name).toMatch(/AssertionError/)
}
function renderForm(source: string) {
  const props = {
    schedule: schedule(),
    schedules: [schedule()],
    overrides: [{ date: '2030-12-24', intervals: [] }],
    version: 'snapshot-1',
    defaultTimeZone: 'UTC',
  }
  const Form = copy<react.ComponentType<typeof props>>(source, 'ScheduleForm')
  render(
    <router.MemoryRouter>
      <InterfaceScope surface="admin">
        <unsaved.UnsavedChangesProvider>
          <Form {...props} />
        </unsaved.UnsavedChangesProvider>
      </InterfaceScope>
    </router.MemoryRouter>,
  )
}

describe('availability source-copy mutations', () => {
  const copySource = weeklySource.slice(
    weeklySource.indexOf('export function copyDay('),
    weeklySource.indexOf('/** Minutes since midnight'),
  )
  it('detects shared copied intervals and copied hidden unavailable hours', async () => {
    await detects(
      copySource,
      'from.intervals.map((i) => intervalDraft(i.start, i.end))',
      'from.intervals',
      (source) => {
        const original = hours.newScheduleDraft('UTC')
        const next = copy<typeof hours.copyDay>(source, 'copyDay')(original, 'monday', ['tuesday'])
        expect(next.days.tuesday.intervals[0]).not.toBe(original.days.monday.intervals[0])
      },
    )
    await detects(copySource, 'from.available ?', 'true ?', (source) => {
      const original = hours.newScheduleDraft('UTC')
      original.days.monday.available = false
      expect(
        copy<typeof hours.copyDay>(source, 'copyDay')(original, 'monday', ['tuesday']).days.tuesday
          .intervals,
      ).toEqual([])
    })
  })
  it('detects dropping staged date overrides from the combined save', async () => {
    await detects(
      formSource,
      'overrides: overridesBody(overrideDrafts)',
      'overrides: []',
      async (source) => {
        const api = fakeApi({
          [`PUT /api/v1/schedules/${SCHEDULE_ID}/availability`]: () =>
            json(200, { schedule: schedule(), overrides: [], version: 'snapshot-2' }),
        })
        renderForm(source)
        await userEvent.setup().click(screen.getByRole('button', { name: 'Save changes' }))
        await screen.findByText('Saved.')
        expect(api.to(`PUT /api/v1/schedules/${SCHEDULE_ID}/availability`)[0]?.body).toMatchObject({
          overrides: [{ date: '2030-12-24', intervals: [] }],
        })
      },
    )
  })
  it('detects omitting the concurrency token', async () => {
    await detects(formSource, 'expectedVersion: version', 'expectedVersion: ""', async (source) => {
      const api = fakeApi({
        [`PUT /api/v1/schedules/${SCHEDULE_ID}/availability`]: () =>
          json(200, { schedule: schedule(), overrides: [], version: 'snapshot-2' }),
      })
      renderForm(source)
      await userEvent.setup().click(screen.getByRole('button', { name: 'Save changes' }))
      await screen.findByText('Saved.')
      expect(api.to(`PUT /api/v1/schedules/${SCHEDULE_ID}/availability`)[0]?.body).toMatchObject({
        expectedVersion: 'snapshot-1',
      })
    })
  })
  it('detects omitting the actual dirty guard for override-only edits', async () => {
    await detects(
      formSource,
      'useUnsavedChanges(dirty)',
      'useUnsavedChanges(false)',
      async (source) => {
        renderForm(source)
        await userEvent
          .setup()
          .click(screen.getByRole('button', { name: 'Remove override: 2030-12-24' }))
        const unload = new Event('beforeunload', { cancelable: true })
        window.dispatchEvent(unload)
        expect(unload.defaultPrevented).toBe(true)
      },
    )
  })
  it('detects omitting override validation before the combined write', async () => {
    await detects(formSource, '...overrideErrors(overrideDrafts)', '...{}', async (source) => {
      const api = fakeApi({
        [`PUT /api/v1/schedules/${SCHEDULE_ID}/availability`]: () =>
          json(200, { schedule: schedule(), overrides: [], version: 'snapshot-2' }),
      })
      renderForm(source)
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Add a date override' }))
      await user.click(screen.getByRole('button', { name: 'Save changes' }))
      await waitFor(() => expect(screen.queryByText('Saving…')).toBeNull())
      expect(api.to(`PUT /api/v1/schedules/${SCHEDULE_ID}/availability`)).toHaveLength(0)
    })
  })
  it('detects losing the end-of-day conversion', async () => {
    const source = weeklySource.slice(
      weeklySource.indexOf('export const toApiTime'),
      weeklySource.indexOf('// Field ids'),
    )
    await detects(source, "isEnd && time === '00:00' ? '24:00' : time", 'time', (source) => {
      expect(copy<typeof hours.toApiTime>(source, 'toApiTime')('00:00', true)).toBe('24:00')
    })
  })
})
