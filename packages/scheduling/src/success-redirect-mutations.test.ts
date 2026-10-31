import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import type * as Redirect from './success-redirect.ts'

async function sourceCopy(mutate: (source: string) => string) {
  const location = new URL('./success-redirect.ts', import.meta.url)
  const original = readFileSync(location, 'utf8')
  const modified = mutate(original)
  expect(modified).not.toBe(original)
  const source = stripTypeScriptTypes(modified).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) as Promise<
    typeof Redirect
  >
}
const requireRejection = (module: typeof Redirect, input: unknown) =>
  expect(() => module.validateSuccessRedirect(input)).toThrowError()
const valid = { url: 'https://example.com' }

describe('redirect source-copy mutation controls', () => {
  it.each([
    {
      name: 'HTTPS-only schemes',
      mutate: (source: string) =>
        source
          .replace('!/^https:\\/\\//i.test(raw)', 'false')
          .replace("target.protocol !== 'https:'", 'false'),
      verify: (module: typeof Redirect) => requireRejection(module, { url: 'http://example.com' }),
    },
    {
      name: 'raw controls and whitespace',
      mutate: (source: string) =>
        source.replace('!isSingleLineText(raw)', 'false').replace('/\\s/u.test(raw)', 'false'),
      verify: (module: typeof Redirect) =>
        requireRejection(module, { url: 'https://exa\tmple.com' }),
    },
    {
      name: 'raw length before normalization',
      mutate: (source: string) =>
        source.replace('raw.length > SUCCESS_REDIRECT_MAX_LENGTH', 'false'),
      verify: (module: typeof Redirect) =>
        requireRejection(module, { url: `https://EXAMPLE.com:443/${'x'.repeat(1979)}` }),
    },
    {
      name: 'normalized URL length',
      mutate: (source: string) =>
        source.replace('target.href.length > SUCCESS_REDIRECT_MAX_LENGTH', 'false'),
      verify: (module: typeof Redirect) =>
        requireRejection(module, { url: `https://example.com/${'東'.repeat(300)}` }),
    },
    {
      name: 'userinfo including empty credentials',
      mutate: (source: string) => source.replace("authority.includes('@')", 'false'),
      verify: (module: typeof Redirect) =>
        requireRejection(module, { url: 'https://@example.com' }),
    },
    {
      name: 'normalized IP literals',
      mutate: (source: string) =>
        source.replace('ip && policy.allowIpHosts !== true && host !== ownHost', 'false'),
      verify: (module: typeof Redirect) => requireRejection(module, { url: 'https://2130706433' }),
    },
    {
      name: 'explicit parameter whitelist',
      mutate: (source: string) =>
        source.replace(
          'parameters.some((key) => !SUCCESS_REDIRECT_PARAMETERS.includes(key))',
          'false',
        ),
      verify: (module: typeof Redirect) =>
        requireRejection(module, { ...valid, parameters: ['manageToken'] }),
    },
    {
      name: 'personal-data opt-in',
      mutate: (source: string) =>
        source.replace('input.includeInviteePersonalData !== true &&', 'false &&'),
      verify: (module: typeof Redirect) =>
        requireRejection(module, { ...valid, parameters: ['inviteeEmail'] }),
    },
    {
      name: 'strict parent permission type',
      mutate: (source: string) =>
        source.replace("input[key] !== undefined && typeof input[key] !== 'boolean'", 'false'),
      verify: (module: typeof Redirect) =>
        requireRejection(module, { ...valid, allowEmbedParent: 'true' }),
    },
    {
      name: 'parent permission defaults off',
      mutate: (source: string) =>
        source.replace(
          'allowEmbedParent: input.allowEmbedParent === true',
          'allowEmbedParent: true',
        ),
      verify: (module: typeof Redirect) =>
        expect(module.validateSuccessRedirect(valid)?.allowEmbedParent).toBe(false),
    },
    {
      name: 'query preservation',
      mutate: (source: string) =>
        source.replace(
          'url.searchParams.append(key, values[key])',
          'url.searchParams.set(key, values[key])',
        ),
      verify: (module: typeof Redirect) => {
        const result = module.bookingSuccessRedirect(
          module.validateSuccessRedirect({
            url: 'https://example.com?start=old',
            parameters: ['start'],
          }),
          values,
        )
        expect(new URL(result?.url as string).searchParams.getAll('start')).toEqual([
          'old',
          'new&value',
        ])
      },
    },
    {
      name: 'correct parameter encoding',
      mutate: (source: string) =>
        source.replace(
          'url.searchParams.append(key, values[key])',
          "url.search = url.search + '&' + key + '=' + values[key]",
        ),
      verify: (module: typeof Redirect) => {
        const result = module.bookingSuccessRedirect(
          module.validateSuccessRedirect({ ...valid, parameters: ['start'] }),
          values,
        )
        expect(new URL(result?.url as string).searchParams.get('start')).toBe('new&value')
      },
    },
  ])(
    'detects removed $name protection with a real assertion failure',
    async ({ mutate, verify }) => {
      const copy = await sourceCopy(mutate)
      expect(() => verify(copy)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    },
  )
})

const values: Record<Redirect.SuccessRedirectParameter, string> = {
  eventTypeSlug: 'call',
  start: 'new&value',
  end: 'end',
  timeZone: 'UTC',
  hostName: 'Host',
  inviteeName: 'Invitee',
  inviteeEmail: 'invitee@example.com',
}
