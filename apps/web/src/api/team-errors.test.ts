import { describe, expect, it } from 'vitest'
import { translateMessage } from '../i18n/translate.ts'
import { errorFromResponse, errorMessage, requestError } from './errors.ts'

const teamErrors = [
  {
    status: 400,
    code: 'ORGANIZATION_ALREADY_EXISTS',
    english: 'This team address is already in use. Choose another one.',
    chinese: '此团队地址已被使用。请选择其他地址。',
  },
  {
    status: 400,
    code: 'ORGANIZATION_SLUG_RESERVED',
    english: 'This team address is reserved. Choose another one.',
    chinese: '此团队地址为保留地址。请选择其他地址。',
  },
  {
    status: 403,
    code: 'YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION',
    english: "You don't have permission to create a team.",
    chinese: '你没有创建团队的权限。',
  },
  {
    status: 403,
    code: 'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION',
    english: 'You no longer have access to this team. Choose another team.',
    chinese: '你已无权访问此团队。请选择其他团队。',
  },
] as const

describe('team organization error messages', () => {
  it.each(teamErrors)('localizes Better Auth $code from its code', async (testCase) => {
    // No admin catalog registration: errors also work before the lazy session graph loads.
    for (const message of ['Unrelated server detail.', 'Changed server detail.']) {
      const error = await errorFromResponse(
        new Response(JSON.stringify({ code: testCase.code, message }), {
          status: testCase.status,
          headers: { 'content-type': 'application/json' },
        }),
      )
      expect(error.status).toBe(testCase.status)
      expect(error.code).toBe(testCase.code)
      expect(translateMessage('en', errorMessage(error))).toBe(testCase.english)
      expect(translateMessage('zh-CN', errorMessage(error))).toBe(testCase.chinese)
    }
  })

  it.each([new TypeError('Failed to fetch'), new Error('Network disconnected')])(
    'uses existing localized network guidance for %s',
    (error) => {
      expect(translateMessage('en', errorMessage(error))).toBe(
        "Can't reach Hourmere. Check your connection and try again.",
      )
      expect(translateMessage('zh-CN', errorMessage(error))).toBe(
        '无法连接 Hourmere。请检查网络连接后重试。',
      )
    },
  )

  it('keeps the existing session and generic permission messages', () => {
    const session = errorMessage(requestError(401, { code: 'UNAUTHORIZED', message: 'Detail.' }))
    expect(translateMessage('en', session)).toBe('Your session has ended. Sign in again.')
    expect(translateMessage('zh-CN', session)).toBe('你的登录已过期。请重新登录。')
    const forbidden = errorMessage(requestError(403, { code: 'FORBIDDEN', message: 'Detail.' }))
    expect(translateMessage('en', forbidden)).toBe("You don't have permission to do that.")
    expect(translateMessage('zh-CN', forbidden)).toBe('你没有执行此操作的权限。')
  })

  it.each(['Unknown organization failure.', 'Settings'])(
    'preserves unknown server prose verbatim: %s',
    (message) => {
      const error = errorMessage(requestError(400, { code: 'FUTURE_TEAM_ERROR', message }))
      expect(translateMessage('en', error)).toBe(message)
      expect(translateMessage('zh-CN', error)).toBe(message)
    },
  )
})
