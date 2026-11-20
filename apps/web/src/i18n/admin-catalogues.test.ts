import { type InterfaceLanguage, registeredLocales } from '@hourmere/core/language'
import { describe, expect, it, vi } from 'vitest'
import { errorMessage, requestError } from '../api/errors.ts'
import './admin.ts'
import { knownMessage, registerCatalogues } from './catalogues.ts'
import { type MessageKey, translate, translateMessage } from './translate.ts'

vi.hoisted(() => vi.resetModules())
vi.mock('@hourmere/core/locales', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hourmere/core/locales')>()
  return {
    ...original,
    localeRegistry: {
      ...original.localeRegistry,
      qaa: {
        code: 'qaa',
        nativeName: 'Fixture language',
        fallbacks: ['en'],
        formatLocale: 'de-DE',
        direction: 'ltr',
      },
    },
  }
})
vi.mock('./catalogues/en/admin.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./catalogues/en/admin.ts')>()
  return {
    ...original,
    admin: { ...original.admin, 'fixture.admin.only': 'English team fallback {name}' },
  }
})

describe('admin catalogue discovery', () => {
  it('loads both source and translated team messages through the lazy admin loader', () => {
    expect(knownMessage('Create team')).toBe(true)
    expect(translate('en', 'Create team')).toBe('Create team')
    expect(translate('zh-CN', 'Create team')).toBe('创建团队')
    expect(translate('zh-CN', 'Your role')).toBe('你的角色')
  })

  it.each([
    [
      'sso_test_required',
      'Test this single sign-on provider’s current configuration before enabling it.',
      '启用此单点登录提供者前，请测试其当前配置。',
    ],
    [
      'sso_domain_unverified',
      'Verify a domain linked to this single sign-on provider and try again.',
      '请验证与此单点登录提供者关联的域名后重试。',
    ],
    [
      'sso_last_provider',
      'This team must keep at least one usable provider while single sign-on is enforced.',
      '团队启用强制单点登录时，必须保留至少一个可用的提供者。',
    ],
  ])('localizes the provider activation refusal %s', (code, english, chinese) => {
    const message = errorMessage(requestError(409, { error: code }))
    expect(translateMessage('en', message)).toBe(english)
    expect(translateMessage('zh-CN', message)).toBe(chinese)
  })

  it('uses partial admin translations and per-key English fallback for another registered locale', () => {
    const fixture = 'qaa' as InterfaceLanguage
    expect(registeredLocales.some(({ code }) => code === fixture)).toBe(true)
    registerCatalogues({
      './catalogues/qaa/admin.ts': { 'Create team': 'Fixture create team' },
    })
    expect(translate(fixture, 'Create team')).toBe('Fixture create team')
    expect(translate(fixture, 'Team public address')).toBe('Team public address')
    const key = 'fixture.admin.only' as MessageKey
    expect(knownMessage(key)).toBe(true)
    expect(translate(fixture, key, { name: 'Ada' })).toBe('English team fallback Ada')
    expect(translateMessage(fixture, { key, values: { name: 'Ada' } })).toBe(
      'English team fallback Ada',
    )
  })
})
