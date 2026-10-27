import { type InterfaceLanguage, registeredLocales } from '@hourmere/core/language'
import { describe, expect, it, vi } from 'vitest'
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
