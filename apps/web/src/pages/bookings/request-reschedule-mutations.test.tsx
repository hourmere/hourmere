import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as react from 'react'
import { describe, expect, it } from 'vitest'
import { RequestError } from '../../api/errors.ts'
import { booking } from '../../test/public-fixtures.ts'
import type { RequestReschedule } from './RequestReschedule.tsx'

const source = readFileSync('apps/web/src/pages/bookings/RequestReschedule.tsx', 'utf8')
function Field({ children }: { children: (props: object) => react.ReactNode }) {
  return children({ 'aria-label': 'Note' })
}
function OrganizationContextConflict() {
  return null
}
function component(text: string, calls: unknown[]) {
  const compiled = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import {readFileSync} from 'node:fs'; import {transformSync} from 'esbuild'; process.stdout.write(transformSync(readFileSync(0,'utf8'),{loader:'tsx',format:'cjs',jsxFactory:'react.createElement'}).code)",
    ],
    {
      input: text.replace(/^import[\s\S]*?from '[^']+'$/gm, '').replace(/^export /gm, ''),
      encoding: 'utf8',
    },
  )
  let key = 0
  const deps = {
    react,
    useState: react.useState,
    useRef: react.useRef,
    api: {
      POST: async (_path: string, input: { body: unknown }) => {
        calls.push(input.body)
        throw new Error('uncertain')
      },
    },
    unwrap: (value: Promise<unknown>) => value,
    useMounted: () => react.useRef(true),
    useI18n: () => ({ t: (key: string) => key, ui: () => 'Error' }),
    useUnsavedChanges: () => {},
    randomKey: () => `key-${++key}`,
    msg: (key: string) => key,
    errorMessage: () => 'Error',
    isOrganizationContextChanged: () => false,
    RequestError,
    Field,
    OrganizationContextConflict,
  }
  return new Function(...Object.keys(deps), `${compiled}; return RequestReschedule`)(
    ...Object.values(deps),
  ) as typeof RequestReschedule
}
async function check(text: string, protection: 'bound' | 'replay') {
  const calls: unknown[] = []
  const Component = component(text, calls)
  try {
    render(
      <Component booking={booking()} expectedOrganizationId="organization" onChange={() => {}} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Request reschedule' }))
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: protection === 'bound' ? 'x'.repeat(2001) : 'Move please' },
    })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send request' })))
    if (protection === 'bound') expect(calls).toHaveLength(0)
    else {
      await waitFor(() => expect(calls).toHaveLength(1))
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Retry the same request' })),
      )
      await waitFor(() => expect(calls).toHaveLength(2))
      expect(calls[1]).toEqual(calls[0])
    }
  } finally {
    cleanup()
  }
}
describe('request form source-copy protections', () => {
  it.each([
    ['bound', 'note.length > 2000', 'false'],
    ['replay', 'attempt.current ??=', 'attempt.current ='],
  ] as const)('detects removing %s', async (protection, from, to) => {
    expect(source.split(from)).toHaveLength(2)
    await check(source, protection)
    await expect(check(source.replace(from, to), protection)).rejects.toMatchObject({
      name: 'AssertionError',
    })
    await check(source, protection)
  })
})
