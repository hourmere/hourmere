import { describe, expect, it } from 'vitest'
import '../i18n/admin.ts'
import { translateMessage } from '../i18n/translate.ts'
import { errorMessage, requestError } from './errors.ts'

describe('API key policy errors in the admin interface', () => {
  it.each([
    [
      403,
      'insufficient_scope',
      'This API key does not allow this operation.',
      '此 API 密钥不允许执行这项操作。',
    ],
    [
      400,
      'API_KEY_SCOPE_IMMUTABLE',
      'API key scope cannot be changed; create a replacement key.',
      'API 密钥的权限范围无法修改；请创建新密钥来替换。',
    ],
    [
      403,
      'SESSION_REQUIRED',
      'Use a browser session without an Authorization header.',
      '请使用浏览器登录会话，并移除 Authorization 请求头。',
    ],
    [
      400,
      'INVALID_METADATA',
      'Check the API key organization and scope.',
      '请检查 API 密钥的所属组织和权限范围。',
    ],
  ] as const)('localizes %s %s without showing raw server details', (status, code, en, zh) => {
    const error = requestError(status, { code, message: 'Synthetic server detail' })
    expect(translateMessage('en', errorMessage(error))).toBe(en)
    expect(translateMessage('zh-CN', errorMessage(error))).toBe(zh)
  })
})
