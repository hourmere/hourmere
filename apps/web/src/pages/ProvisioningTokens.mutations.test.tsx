import '../i18n/admin.ts'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as react from 'react'
import { type ComponentType, useCallback, useEffect, useState } from 'react'
import { Link, MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
import { api, unwrap } from '../api/client.ts'
import { BreakableText } from '../components/BreakableText.tsx'
import { CopyButton } from '../components/CopyButton.tsx'
import { useLoad, useMounted } from '../hooks.ts'
import { AccountLanguage, InterfaceScope, useI18n } from '../i18n/runtime.tsx'
import { fakeApi, json } from '../test/fake-api.tsx'

const source = readFileSync('apps/web/src/pages/ProvisioningTokens.tsx', 'utf8')
function copy(code: string) {
  const compiled = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { readFileSync } from 'node:fs'; import { transformSync } from 'esbuild'; process.stdout.write(transformSync(readFileSync(0, 'utf8'), { loader: 'tsx', format: 'cjs', jsxFactory: 'reactRuntime.createElement', jsxFragment: 'reactRuntime.Fragment' }).code)",
    ],
    { input: code.replace(/^import .*\n/gm, '').replace(/^export /gm, ''), encoding: 'utf8' },
  )
  const dependencies = {
    api,
    unwrap,
    BreakableText,
    CopyButton,
    useLoad,
    useMounted,
    useI18n,
    useCallback,
    useEffect,
    useState,
    useLocation,
  }
  return new Function(
    'reactRuntime',
    ...Object.keys(dependencies),
    `${compiled}; return ProvisioningTokens`,
  )(react, ...Object.values(dependencies)) as ComponentType<{
    organizationId: string
    role: string | null
    timeZone?: string
  }>
}
const ORG = 'organization-one'
const BASE = `/api/v1/organizations/${ORG}/provisioning-tokens`
const MARKER = 'noncredential-display-marker'
function mutate(before: string, after: string) {
  expect(source.split(before)).toHaveLength(2)
  return source.replace(before, after)
}
async function check(code: string, mode: 'flag' | 'role' | 'dismiss' | 'navigate' | 'scope') {
  const Component = copy(code)
  const calls = fakeApi({
    'GET /api/v1/instance': () => json(200, { scimProvisioningEnabled: mode !== 'flag' }),
    [`GET ${BASE}`]: () => json(200, { tokens: [] }),
    [`POST ${BASE}`]: () => json(201, { token: {}, secret: MARKER }),
  })
  render(
    <MemoryRouter>
      <Component organizationId={ORG} role={mode === 'role' ? 'member' : 'owner'} />
      <Link to="?new">Navigate</Link>
    </MemoryRouter>,
  )
  const user = userEvent.setup()
  if (mode === 'flag' || mode === 'role') {
    // Flush the request/effect rather than accepting an initial hidden loading render.
    await user.click(screen.getByRole('link', { name: 'Navigate' }))
    expect(
      screen.queryByRole(mode === 'flag' ? 'button' : 'heading', {
        name: mode === 'flag' ? 'Create provisioning token' : 'SCIM provisioning tokens',
      }) === null,
    ).toBe(true)
    return
  }
  await user.type(await screen.findByLabelText('Provisioning token name'), 'Directory')
  await user.click(screen.getByRole('button', { name: 'Create provisioning token' }))
  await screen.findByRole('region', { name: 'New provisioning token' })
  if (mode === 'scope') {
    expect(calls.to(`POST ${BASE}`)[0]?.headers.get('X-Expected-Organization-Id') === ORG).toBe(
      true,
    )
    return
  }
  await user.click(
    screen.getByRole(mode === 'dismiss' ? 'button' : 'link', {
      name: mode === 'dismiss' ? 'Dismiss token' : 'Navigate',
    }),
  )
  expect(document.body.textContent?.includes(MARKER) === false).toBe(true)
}
async function checkRevision(
  code: string,
  mode: 'owner' | 'offList' | 'date' | 'zone' | 'locale' | 'expiry' | 'page',
) {
  const Component = copy(code)
  const lastUsedAt = '2026-11-06T12:00:00Z'
  const calls = fakeApi({
    'GET /api/v1/instance': () => json(200, { scimProvisioningEnabled: mode !== 'offList' }),
    [`GET ${BASE}`]: (call) =>
      json(200, {
        tokens: [
          {
            id: 'token-1',
            name: call.path.includes('after=token-1') ? 'Second directory' : 'Directory',
            revokedAt: null,
            lastUsedAt,
            previousValidUntil: '2000-01-01T00:00:00Z',
          },
        ],
        nextCursor: 'token-1',
      }),
  })
  render(
    <MemoryRouter>
      <InterfaceScope surface="admin">
        <AccountLanguage locale="zh-CN">
          <Component
            organizationId={ORG}
            role={mode === 'owner' ? 'admin' : 'owner'}
            timeZone="Pacific/Honolulu"
          />
        </AccountLanguage>
      </InterfaceScope>
    </MemoryRouter>,
  )
  const user = userEvent.setup()
  if (mode === 'offList') {
    await user.click(await screen.findByRole('button', { name: '撤销令牌' }))
    expect(calls.to(`GET ${BASE}`).length > 0).toBe(true)
    return
  }
  await screen.findByText('Directory')
  if (mode === 'owner') {
    expect(screen.queryByRole('button', { name: '创建预配令牌' }) === null).toBe(true)
    expect(screen.queryByRole('button', { name: '轮换令牌' }) === null).toBe(true)
  } else if (mode === 'expiry') {
    expect(screen.queryByText('启用') !== null).toBe(true)
  } else if (mode === 'page') {
    await user.click(screen.getByRole('button', { name: '下一页' }))
    // The callback resolves immediately; flush effects with a harmless click.
    await user.click(screen.getByRole('heading', { name: 'SCIM 预配令牌' }))
    expect(screen.queryByText('Second directory') !== null).toBe(true)
    expect(calls.to(`GET ${BASE}`).at(-1)?.path.includes('after=token-1')).toBe(true)
  } else {
    const formatted = new Intl.DateTimeFormat('zh-CN', {
      calendar: 'gregory',
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Pacific/Honolulu',
    }).format(new Date(lastUsedAt))
    expect(document.body.textContent?.includes(formatted)).toBe(true)
  }
}
describe('SCIM UI source-copy negative controls', () => {
  const cases = [
    ['flag', '        instance.data.scimProvisioningEnabled === true &&\n', ''],
    [
      'role',
      "!role?.split(',').some((value) => ['owner', 'admin'].includes(value.trim()))",
      'false',
    ],
    ['dismiss', 'onClick={() => setSecret(null)}', 'onClick={() => {}}'],
    [
      'navigate',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: exact production source mutation
      'key={`${organizationId}:${location.key}:${role}`}',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: exact production source mutation
      'key={`${organizationId}:${role}`}',
    ],
    [
      'scope',
      "            header: { 'x-expected-organization-id': organizationId },",
      '            header: {},',
    ],
  ] as const
  it.each(cases)(
    'detects removal of %s protection through a real assertion',
    async (mode, before, after) => {
      await check(source, mode)
      cleanup()
      await expect(check(mutate(before, after), mode)).rejects.toThrow('expected false to be true')
    },
  )
  const revisions = [
    ['owner', "role?.split(',').some((value) => value.trim() === 'owner') === true", 'true'],
    ['date', 'date: formatDate(token.lastUsedAt)', 'date: token.lastUsedAt'],
    ['zone', '      timeZone,\n    }).format', "      timeZone: 'UTC',\n    }).format"],
    ['locale', 'new Intl.DateTimeFormat(formatLocale,', "new Intl.DateTimeFormat('en-US',"],
    [
      'expiry',
      '                        Date.parse(token.previousValidUntil) > Math.max(now, Date.now())\n',
      '                        true\n',
    ],
    ['page', 'query: { limit: 20, after }', 'query: { limit: 20 }'],
  ] as const
  it.each(revisions)(
    'detects removal of %s revision through a real assertion',
    async (mode, before, after) => {
      await checkRevision(source, mode)
      cleanup()
      await expect(checkRevision(mutate(before, after), mode)).rejects.toThrow(
        'expected false to be true',
      )
    },
  )
  it('keeps revocation visible while the switch is off', async () => {
    await checkRevision(source, 'offList')
    cleanup()
    const modified = mutate(
      "  if (!role?.split(',')",
      "  if (instance.status !== 'ready' || !instance.data.scimProvisioningEnabled || !role?.split(',')",
    )
    await expect(checkRevision(modified, 'offList')).rejects.toThrow('Unable to find role')
  })
})
