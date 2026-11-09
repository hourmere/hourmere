import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as react from 'react'
import { expect, it, vi } from 'vitest'
import { Field } from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import styles from '../../styles.css?raw'
import { ME } from '../../test/fake-api.tsx'
import type { BookingExport } from './BookingExport.tsx'

const source = readFileSync('apps/web/src/pages/bookings/BookingExport.tsx', 'utf8')
function component(change?: [string, string]): typeof BookingExport {
  if (change) expect(source.includes(change[0])).toBe(true)
  const code = (change ? source.replace(...change) : source)
    .replace(/^import[^\n]+\n/gm, '')
    .replace(/^export /gm, '')
  const compiled = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { readFileSync } from 'node:fs'; import { transformSync } from 'esbuild'; process.stdout.write(transformSync(readFileSync(0, 'utf8'), { loader: 'tsx', format: 'cjs', jsxFactory: 'reactRuntime.createElement' }).code)",
    ],
    { input: code, encoding: 'utf8' },
  )
  const deps = { useId: react.useId, useState: react.useState, Field, useI18n, useMe: () => ME }
  return new Function('reactRuntime', ...Object.keys(deps), `${compiled}; return BookingExport`)(
    react,
    ...Object.values(deps),
  )
}
async function verify(Component: typeof BookingExport, failure: boolean) {
  cleanup()
  render(
    <Component
      filters={{ from: '2030-03-01T00:00:00Z', to: '2030-04-01T00:00:00Z' }}
      timeZone="UTC"
      expectedOrganizationId={ME.organization.id}
    />,
  )
  screen.getByText('Export bookings as CSV').closest('details')?.setAttribute('open', '')
  if (!failure) {
    expect(screen.getByLabelText('Include UTF-8 BOM for Excel').closest('label')?.className).toBe(
      'checkbox',
    )
    return
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'export_busy' }, { status: 429 })),
  )
  const button = screen.getByRole('button', { name: 'Download CSV' })
  fireEvent.click(button)
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  expect(screen.queryByRole('alert')?.textContent).toContain('Could not download CSV')
}
it.each([
  ['checkbox target', 'className="checkbox"', 'className="checkbox-label"', false],
  ['download failure feedback', 'setFailed(true)', 'setFailed(false)', true],
] as const)(
  'kills removal of %s in a production-source copy',
  async (_, before, after, failure) => {
    await verify(component(), failure)
    await expect(verify(component([before, after]), failure)).rejects.toMatchObject({
      name: 'AssertionError',
    })
    await verify(component(), failure)
  },
)

it('keeps the actual checkbox at least 24px and detects removal of its size rule', () => {
  function verifySize(css: string) {
    cleanup()
    const Component = component()
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
    try {
      render(<Component filters={{}} timeZone="UTC" expectedOrganizationId={ME.organization.id} />)
      const control = screen.getByLabelText('Include UTF-8 BOM for Excel')
      const computed = getComputedStyle(control)
      expect(Number.parseFloat(computed.minWidth)).toBeGreaterThanOrEqual(24)
      expect(Number.parseFloat(computed.minHeight)).toBeGreaterThanOrEqual(24)
    } finally {
      style.remove()
    }
  }
  const rule = /\.booking-export input\[type="checkbox"\] \{[^}]+\}/
  expect(styles.match(rule)).not.toBeNull()
  verifySize(styles)
  expect(() => verifySize(styles.replace(rule, ''))).toThrowError(
    expect.objectContaining({ name: 'AssertionError' }),
  )
  verifySize(styles)
})

it('kills removal of the account-specific export feedback', async () => {
  async function verifyBusy(Component: typeof BookingExport) {
    cleanup()
    render(
      <Component
        filters={{ from: '2030-03-01T00:00:00Z', to: '2030-04-01T00:00:00Z' }}
        timeZone="UTC"
        expectedOrganizationId={ME.organization.id}
      />,
    )
    screen.getByText('Export bookings as CSV').closest('details')?.setAttribute('open', '')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'export_user_in_progress' }, { status: 409 })),
    )
    const button = screen.getByRole('button', { name: 'Download CSV' })
    fireEvent.click(button)
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
    expect(screen.queryByRole('alert')?.textContent).toBe(
      'An export is already running for your account. Wait for it to finish and try again.',
    )
  }
  await verifyBusy(component())
  await expect(
    verifyBusy(component(['setUserBusy(true)', 'setUserBusy(false)'])),
  ).rejects.toMatchObject({ name: 'AssertionError' })
  await verifyBusy(component())
})
