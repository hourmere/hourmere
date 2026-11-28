import '../../i18n/admin.ts'
import { readFileSync } from 'node:fs'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as react from 'react'
import { describe, expect, it } from 'vitest'
import { Field } from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import { msg } from '../../i18n/translate.ts'
import { compileSourceCopy } from '../../test/compile-source-copy.ts'
import type { TimeUnitField } from './TimeUnitField.tsx'

const original = readFileSync('apps/web/src/pages/event-types/TimeUnitField.tsx', 'utf8')
function component(source: string) {
  const compiled = compileSourceCopy(
    'TimeUnitField',
    source.replace(/^import[\s\S]*?from '[^']+'$/gm, '').replace(/^export /gm, ''),
    {
      loader: 'tsx',
      format: 'cjs',
      jsxFactory: 'react.createElement',
      jsxFragment: 'react.Fragment',
    },
  )
  return new Function(
    'react',
    'useState',
    'Field',
    'useI18n',
    'msg',
    `${compiled}; return TimeUnitField`,
  )(react, react.useState, Field, useI18n, msg) as typeof TimeUnitField
}
function mutate(before: string, after: string) {
  expect(original.split(before), 'unique production-source mutation anchor').toHaveLength(2)
  return original.replace(before, after)
}
function Harness({ Component }: { Component: typeof TimeUnitField }) {
  const [value, setValue] = react.useState('90')
  const [dirty, setDirty] = react.useState(false)
  return (
    <>
      <Component
        id="notice"
        label="Notice"
        value={value}
        onChange={(next) => {
          setValue(next)
          setDirty(true)
        }}
        rule={{ min: 0, max: 525600 }}
      />
      <output data-testid="canonical">{value}</output>
      <output data-testid="dirty">{String(dirty)}</output>
    </>
  )
}
async function assertSource(
  source: string,
  check: (user: ReturnType<typeof userEvent.setup>) => Promise<void>,
) {
  const Component = component(source)
  const view = render(<Harness Component={Component} />)
  try {
    await check(userEvent.setup())
  } finally {
    view.unmount()
  }
}

describe('time input source-copy mutations', () => {
  it.each([
    {
      name: 'hour conversion factor',
      before: 'hours: 60',
      after: 'hours: 1',
      check: async (user: ReturnType<typeof userEvent.setup>) => {
        await user.selectOptions(screen.getByRole('combobox', { name: 'Notice unit' }), 'hours')
        fireEvent.change(screen.getByLabelText('Notice', { exact: true }), {
          target: { value: '2.5' },
        })
        expect(screen.getByTestId('canonical').textContent).toBe('150')
      },
    },
    {
      name: 'whole storage unit protection',
      before: "if (numerator % denominator !== 0n) return 'invalid'",
      after: 'void 0',
      check: async (user: ReturnType<typeof userEvent.setup>) => {
        await user.selectOptions(screen.getByRole('combobox', { name: 'Notice unit' }), 'hours')
        fireEvent.change(screen.getByLabelText('Notice', { exact: true }), {
          target: { value: '0.001' },
        })
        expect(screen.getByTestId('canonical').textContent).toBe('invalid')
      },
    },
    {
      name: 'unit changes do not dirty canonical state',
      before: 'setUnit(nextUnit)',
      after: 'setUnit(nextUnit); onChange(value)',
      check: async (user: ReturnType<typeof userEvent.setup>) => {
        await user.selectOptions(screen.getByRole('combobox', { name: 'Notice unit' }), 'hours')
        expect(screen.getByTestId('canonical').textContent).toBe('90')
        expect(screen.getByTestId('dirty').textContent).toBe('false')
      },
    },
  ])(
    'detects broken $name with a real DOM/state assertion and restores the source copy',
    async ({ before, after, check }) => {
      await assertSource(original, check)
      await expect(assertSource(mutate(before, after), check)).rejects.toMatchObject({
        name: 'AssertionError',
      })
      await assertSource(original, check)
    },
  )
})

it('detects removing the pristine submit guard before a real PATCH call', async () => {
  const editor = readFileSync('apps/web/src/pages/event-types/EventTypeEditor.tsx', 'utf8')
  const source = editor.slice(
    editor.indexOf('  async function submit('),
    editor.indexOf('  async function roundRobinAction('),
  )
  const anchor = `if (saved && !dirty) {
      setStatus('No changes to save.')
      statusRef.current?.focus()
      return
    }`
  expect(source.split(anchor)).toHaveLength(2)
  async function assertSubmit(code: string) {
    const calls: unknown[] = []
    const noop = () => {}
    const deps = {
      canSave: true,
      usesEffective: false,
      saved: { id: 'saved', schedulingType: 'individual' },
      dirty: false,
      setAttempt: noop,
      setFormError: noop,
      setStatus: noop,
      validateDraft: () => ({}),
      draft: { payment: { enabled: false } },
      baseline: {},
      me: { organization: { personal: true } },
      setErrors: noop,
      invalidateReadiness: noop,
      statusRef: { current: null },
      setSaving: noop,
      toPatchInput: () => ({ title: 'Original' }),
      headers: {},
      api: {
        // biome-ignore lint/correctness/noComponentHookFactories: fake REST method, not a React component
        PATCH: (...args: unknown[]) => {
          calls.push(args)
          return Promise.resolve({})
        },
      },
      unwrap: (result: Promise<unknown>) => result,
      mounted: { current: false },
    }
    const compiled = compileSourceCopy('submit', code, { loader: 'tsx', format: 'cjs' })
    const submit = new Function(...Object.keys(deps), `${compiled}; return submit`)(
      ...Object.values(deps),
    ) as (event: { preventDefault: () => void }) => Promise<void>
    await submit({ preventDefault: noop })
    expect(calls).toHaveLength(0)
  }
  await assertSubmit(source)
  await expect(assertSubmit(source.replace(anchor, 'void 0'))).rejects.toMatchObject({
    name: 'AssertionError',
  })
  await assertSubmit(source)
})
