import '../i18n/admin.ts'
import { readFileSync } from 'node:fs'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as react from 'react'
import { type ComponentType, useCallback, useId, useState } from 'react'
import { describe, expect, it } from 'vitest'
import { api, unwrap } from '../api/client.ts'
import { errorMessage, isOrganizationContextChanged, RequestError } from '../api/errors.ts'
import { loadProfile } from '../api/resources.ts'
import { BreakableText } from '../components/BreakableText.tsx'
import { ErrorSummary, Field, parseWhole } from '../components/forms.tsx'
import { PageHeader } from '../components/PageHeader.tsx'
import { PageSkeleton } from '../components/PageSkeleton.tsx'
import { isKnownTimeZone, zoned } from '../format.ts'
import { useLoad, useMounted, usePageTitle } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import { msg } from '../i18n/translate.ts'
import { compileSourceCopy } from '../test/compile-source-copy.ts'
import { fakeApi, json, ME, PROFILE } from '../test/fake-api.tsx'
import { isCalendarDate, nextCalendarDate, startOfLocalDay } from './audit-log-time.ts'

const FILE = 'apps/web/src/pages/AuditLog.tsx'
const source = readFileSync(FILE, 'utf8')
const ORG = ME.organization.id

function copy(code: string) {
  const compiled = compileSourceCopy(
    FILE,
    code.replace(/^import [\s\S]*?from .*\n/gm, '').replace(/^export /gm, ''),
    {
      loader: 'tsx',
      format: 'cjs',
      jsxFactory: 'reactRuntime.createElement',
      jsxFragment: 'reactRuntime.Fragment',
    },
  )
  const dependencies = {
    useCallback,
    useId,
    useState,
    api,
    unwrap,
    errorMessage,
    isOrganizationContextChanged,
    RequestError,
    loadProfile,
    BreakableText,
    ErrorSummary,
    Field,
    parseWhole,
    PageHeader,
    PageSkeleton,
    isKnownTimeZone,
    zoned,
    useLoad,
    useMounted,
    usePageTitle,
    useI18n,
    msg,
    useMe: () => ME,
    isCalendarDate,
    nextCalendarDate,
    startOfLocalDay,
  }
  return new Function(
    'reactRuntime',
    ...Object.keys(dependencies),
    `${compiled}; return AuditLogPage`,
  )(react, ...Object.values(dependencies)) as ComponentType
}

function mutate(before: string, after: string) {
  expect(source.split(before)).toHaveLength(2)
  return source.replace(before, after)
}

const query = (path: string | undefined) =>
  Object.fromEntries(new URL(path ?? '', 'http://x').searchParams)

type Mode =
  | 'endDay'
  | 'eventsScope'
  | 'settingsScope'
  | 'saveScope'
  | 'readOnly'
  | 'zone'
  | 'redactedTarget'

async function check(code: string, mode: Mode) {
  const Page = copy(code)
  const calls = fakeApi({
    'GET /api/v1/profile': () => json(200, { ...PROFILE, timeZone: 'America/Los_Angeles' }),
    'GET /api/v1/audit-events': () =>
      json(200, {
        data: [
          {
            id: '1',
            occurredAt: '2026-11-12T17:04:05.123456Z',
            action: 'api_key.created',
            actor: { type: 'system', id: 'jobs' },
            credential: {
              type: 'none',
              apiKeyId: null,
              apiKeyScope: null,
              oauthClientId: null,
              oauthGrantId: null,
            },
            target:
              mode === 'redactedTarget'
                ? { type: 'session', id: null }
                : { type: 'api_key', id: 'key-1' },
            details: {},
            requestId: null,
          },
        ],
        nextCursor: null,
      }),
    'GET /api/v1/audit-log/settings': () =>
      json(200, {
        retention: 'instance',
        retentionDays: null,
        instanceRetentionDays: null,
        effectiveRetentionDays: null,
        canChangeRetention: mode !== 'readOnly',
      }),
    'PUT /api/v1/audit-log/settings': () =>
      json(200, {
        retention: 'forever',
        retentionDays: null,
        instanceRetentionDays: null,
        effectiveRetentionDays: null,
        canChangeRetention: true,
      }),
  })
  render(<Page />)
  const table = await screen.findByRole('table')
  await screen.findByText('Current retention')
  const user = userEvent.setup()
  if (mode === 'endDay') {
    fireEvent.change(screen.getByLabelText(/^End date/), { target: { value: '2026-11-01' } })
    await user.click(screen.getByRole('button', { name: 'Apply filters' }))
    await waitFor(() => expect(calls.to('GET /api/v1/audit-events')).toHaveLength(2))
    // 1 November is included up to its end: the next local day starts at 08:00Z.
    expect(query(calls.to('GET /api/v1/audit-events')[1]?.path).to === '2026-11-02T08:00:00Z').toBe(
      true,
    )
  } else if (mode === 'eventsScope') {
    expect(
      calls.to('GET /api/v1/audit-events')[0]?.headers.get('x-expected-organization-id') === ORG,
    ).toBe(true)
  } else if (mode === 'settingsScope') {
    expect(
      calls.to('GET /api/v1/audit-log/settings')[0]?.headers.get('x-expected-organization-id') ===
        ORG,
    ).toBe(true)
  } else if (mode === 'saveScope') {
    await user.click(screen.getByRole('radio', { name: 'Keep forever' }))
    await user.click(screen.getByRole('button', { name: 'Save retention' }))
    await screen.findByText('Retention saved.')
    expect(
      calls.to('PUT /api/v1/audit-log/settings')[0]?.headers.get('x-expected-organization-id') ===
        ORG,
    ).toBe(true)
  } else if (mode === 'readOnly') {
    expect(screen.queryByRole('button', { name: 'Save retention' }) === null).toBe(true)
  } else if (mode === 'redactedTarget') {
    expect(table.querySelector('td[data-label="Target"]')?.textContent === 'session').toBe(true)
  } else {
    // 17:04 UTC is 09:04 in the profile zone.
    expect(/\b9:04\b/.test(within(table).getAllByRole('rowheader')[0]?.textContent ?? '')).toBe(
      true,
    )
  }
}

describe('audit log source-copy negative controls', () => {
  const cases = [
    [
      'endDay',
      'to: startOfLocalDay(nextCalendarDate(filters.endDate), timeZone)',
      'to: startOfLocalDay(filters.endDate, timeZone)',
    ],
    [
      'eventsScope',
      "              query: eventQuery(filters, timeZone, cursor),\n              header: { 'x-expected-organization-id': organizationId },\n",
      '              query: eventQuery(filters, timeZone, cursor),\n',
    ],
    [
      'settingsScope',
      "api.GET('/api/v1/audit-log/settings', {\n            params: { header: { 'x-expected-organization-id': organizationId } },\n",
      "api.GET('/api/v1/audit-log/settings', {\n",
    ],
    [
      'saveScope',
      "api.PUT('/api/v1/audit-log/settings', {\n          params: { header: { 'x-expected-organization-id': organizationId } },\n",
      "api.PUT('/api/v1/audit-log/settings', {\n",
    ],
    ['readOnly', '{view.canChangeRetention ? (', '{true ? ('],
    ['zone', 'zoned(timeZone, formatLocale)', "zoned('UTC', formatLocale)"],
    ['redactedTarget', '{target.id && <Id>{target.id}</Id>}', "{<Id>{target.id ?? 'null'}</Id>}"],
  ] as const
  it.each(cases)(
    'detects removal of the %s protection through a real assertion',
    async (mode, before, after) => {
      await check(source, mode)
      cleanup()
      await expect(check(mutate(before, after), mode)).rejects.toThrow('expected false to be true')
    },
  )
})
