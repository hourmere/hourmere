import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import { hasUnsafeJsonText } from './app.ts'
import {
  successRedirectErrorField,
  successRedirectIssueField,
  successRedirectUnsafeField,
} from './success-redirect-errors.ts'

type Helpers = {
  successRedirectErrorField: typeof successRedirectErrorField
  successRedirectIssueField: typeof successRedirectIssueField
  successRedirectUnsafeField: typeof successRedirectUnsafeField
}
function sourceCopy(change?: readonly [string, string]): Helpers {
  let source = readFileSync('apps/server/src/success-redirect-errors.ts', 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'mutation must match').toBe(true)
    source = source.replace(...change)
  }
  return new Function(
    `${stripTypeScriptTypes(source).replace(/\bexport /g, '')}; return {successRedirectErrorField, successRedirectIssueField, successRedirectUnsafeField}`,
  )() as Helpers
}
function verify(helpers: Helpers) {
  for (const field of ['url', 'parameters', 'includeInviteePersonalData', 'allowEmbedParent']) {
    expect(
      helpers.successRedirectErrorField(
        'invalid_success_redirect',
        `successRedirect.${field} must be valid`,
      ),
    ).toBe(`successRedirect.${field}`)
    expect(helpers.successRedirectIssueField([{ path: ['successRedirect', field, 0] }])).toBe(
      `successRedirect.${field}`,
    )
  }
  expect(
    helpers.successRedirectErrorField(
      'invalid_success_redirect',
      'Invitee names and emails become visible. Set includeInviteePersonalData to true to explicitly opt in.',
    ),
  ).toBe('successRedirect.includeInviteePersonalData')
  expect(
    helpers.successRedirectErrorField(
      'invalid_success_redirect',
      'successRedirect contains an unknown setting',
    ),
  ).toBe('successRedirect')
  expect(
    helpers.successRedirectErrorField('other', 'successRedirect.url must be valid'),
  ).toBeUndefined()
  expect(helpers.successRedirectIssueField([{ path: ['successRedirect', 'unknown'] }])).toBe(
    'successRedirect',
  )
  expect(helpers.successRedirectIssueField([{ path: ['title'] }])).toBeUndefined()
  for (const field of ['url', 'parameters', 'includeInviteePersonalData', 'allowEmbedParent'])
    expect(
      helpers.successRedirectUnsafeField(
        { successRedirect: { [field]: '\u0000' } },
        hasUnsafeJsonText,
      ),
    ).toBe(`successRedirect.${field}`)
  expect(
    helpers.successRedirectUnsafeField({ successRedirect: { url: '\ud800' } }, hasUnsafeJsonText),
  ).toBe('successRedirect.url')
  expect(
    helpers.successRedirectUnsafeField(
      { successRedirect: { 'private\u0000': true } },
      hasUnsafeJsonText,
    ),
  ).toBe('successRedirect')
  expect(
    helpers.successRedirectUnsafeField(
      { title: '\u0000', successRedirect: { url: 'https://target.example.test/' } },
      hasUnsafeJsonText,
    ),
  ).toBeUndefined()
  expect(helpers.successRedirectUnsafeField({ title: '\u0000' }, hasUnsafeJsonText)).toBeUndefined()
}
describe('redirect error field names', () => {
  it('uses stable fields for service and transport errors', () =>
    verify({ successRedirectErrorField, successRedirectIssueField, successRedirectUnsafeField }))
  it('checks an unchanged source copy', () => verify(sourceCopy()))
  it.each<readonly [string, string]>([
    ['if (!unsafe(settings)) return undefined', 'if (false) return undefined'],
    [
      'if (unsafe((settings as Record<string, unknown>)[key])) return field',
      'if (false) return field',
    ],
    ["if (code !== 'invalid_success_redirect') return undefined", 'if (false) return undefined'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: This is an exact source-copy mutation anchor.
    ['if (detail?.startsWith(`${field} `)) return field', 'if (false) return field'],
    ["return 'successRedirect.includeInviteePersonalData'", "return 'successRedirect'"],
    [
      "return SUCCESS_REDIRECT_ERROR_FIELDS.find((known) => known === field) ?? 'successRedirect'",
      "return 'successRedirect'",
    ],
  ])('detects removal of a field mapping', (from, to) => {
    expect(() => verify(sourceCopy([from, to]))).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
