import '../i18n/admin.ts'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as react from 'react'
import { type ComponentType, useCallback, useState } from 'react'
import { Link, MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
import { api, unwrap } from '../api/client.ts'
import { BreakableText } from '../components/BreakableText.tsx'
import { CopyButton } from '../components/CopyButton.tsx'
import { useLoad, useMounted } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
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
    expect(screen.queryByRole('heading', { name: 'SCIM provisioning tokens' }) === null).toBe(true)
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
describe('SCIM UI source-copy negative controls', () => {
  const cases = [
    ['flag', '    instance.data.scimProvisioningEnabled !== true ||\n', ''],
    [
      'role',
      "    !role?.split(',').some((value) => ['owner', 'admin'].includes(value.trim()))",
      '    false',
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
})
