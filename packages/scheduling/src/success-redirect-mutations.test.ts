import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import * as Redirect from './success-redirect.ts'

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
      name: 'empty userinfo before normalization',
      mutate: (source: string) => source.replace('/^:?@/.test(authority)', 'false'),
      verify: (module: typeof Redirect) =>
        requireRejection(module, { url: 'https://@example.com' }),
    },
    {
      name: 'parsed nonempty userinfo',
      mutate: (source: string) =>
        source.replace('target.username ||\n    target.password ||', 'false ||'),
      verify: (module: typeof Redirect) =>
        requireRejection(module, { url: 'https://user:password@example.com' }),
    },
    {
      name: 'raw backslashes',
      mutate: (source: string) => source.replace(String.raw`raw.includes('\\')`, 'false'),
      verify: (module: typeof Redirect) =>
        requireRejection(module, { url: 'https://example.com/path\\segment' }),
    },
    {
      name: 'normalized IP literals',
      mutate: (source: string) => source.replace('const localHost = ip ||', 'const localHost ='),
      verify: (module: typeof Redirect) => requireRejection(module, { url: 'https://2130706433' }),
    },
    {
      name: 'localhost and single-label hosts',
      mutate: (source: string) => source.replace("!host.includes('.')", 'false'),
      verify: (module: typeof Redirect) => requireRejection(module, { url: 'https://intranet' }),
    },
    {
      name: 'localhost subdomains',
      mutate: (source: string) => source.replace("host.endsWith('.localhost')", 'false'),
      verify: (module: typeof Redirect) => requireRejection(module, { url: 'https://a.localhost' }),
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
      name: 'verbatim query preservation',
      mutate: (source: string) =>
        source.replace(
          'url: target + suffix + fragment',
          'url: (() => { const url = new URL(target + suffix + fragment); url.search = url.searchParams.toString(); return url.href })()',
        ),
      verify: (module: typeof Redirect) => {
        const result = module.bookingSuccessRedirect(
          module.validateSuccessRedirect({
            url: 'https://example.com/?x=%zz&flag&a;b&start=old#done',
            parameters: ['start'],
          }),
          values,
        )
        expect(result?.url).toBe(
          'https://example.com/?x=%zz&flag&a;b&start=old&start=new%26value#done',
        )
      },
    },
    {
      name: 'correct parameter encoding',
      mutate: (source: string) =>
        source.replace(
          'new URLSearchParams(settings.parameters.map((key) => [key, values[key]]))',
          "{ size: settings.parameters.length, toString: () => settings.parameters.map((key) => key + '=' + values[key]).join('&') }",
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
      verify(Redirect)
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
