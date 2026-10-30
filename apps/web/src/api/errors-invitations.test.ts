import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import * as translate from '../i18n/translate.ts'
import { errorFromResponse, requestError } from './errors.ts'

const invitationId = '00000000-0000-7000-8000-000000000021'
const code = 'INVITATION_DELIVERY_UNAVAILABLE'

describe('saved replacement invitation errors', () => {
  it.each([
    [503, 'INVITATION_DELIVERY_UNAVAILABLE'],
    [409, 'INVITATION_INELIGIBLE'],
  ])('reads saved invitation ID after dispatch returns %s %s', async (status, code) => {
    const error = await errorFromResponse(
      new Response(JSON.stringify({ code, invitationId }), { status }),
    )
    expect(error.status).toBe(status)
    expect(error.code).toBe(code)
    expect(error.invitationId).toBe(invitationId)
  })

  it.each(['INVITATION_CONFLICT', 'unavailable', undefined])(
    'does not follow an invitation ID from unrelated error %s',
    (otherCode) => {
      expect(requestError(503, { code: otherCode, invitationId }).invitationId).toBeUndefined()
    },
  )

  it.each([undefined, null, 1, {}, [], '', '../invitations', `${invitationId}/cancel`])(
    'ignores malformed invitation metadata %j',
    (value) => {
      expect(requestError(503, { code, invitationId: value }).invitationId).toBeUndefined()
    },
  )
})

function sourceCopy(source: string): typeof requestError {
  const compiled = stripTypeScriptTypes(
    source.replace(/^import .* from .+\n/gm, '').replace(/^export /gm, ''),
  )
  return new Function('literal', 'msg', `${compiled}\nreturn requestError`)(
    translate.literal,
    translate.msg,
  )
}

it('detects removing the replacement error allowlist or UUID check in source copies', () => {
  const source = readFileSync('apps/web/src/api/errors.ts', 'utf8')
  function assertion(parse: typeof requestError) {
    expect(parse(503, { code, invitationId }).invitationId).toBe(invitationId)
    expect(parse(503, { code: 'INVITATION_CONFLICT', invitationId }).invitationId).toBeUndefined()
    expect(
      parse(503, { code, invitationId: `${invitationId}/cancel` }).invitationId,
    ).toBeUndefined()
  }
  assertion(sourceCopy(source))
  for (const [before, after] of [
    [
      "(code === 'INVITATION_DELIVERY_UNAVAILABLE' || code === 'INVITATION_INELIGIBLE') &&",
      'true &&',
    ],
    [
      '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.invitationId)',
      'true',
    ],
  ] as const) {
    expect(source.split(before)).toHaveLength(2)
    expect(() => assertion(sourceCopy(source.replace(before, after)))).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  }
  assertion(sourceCopy(source))
})
