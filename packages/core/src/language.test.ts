import { describe, expect, it } from 'vitest'
import { acceptLanguage, cookieLanguage, explicitLanguage, interfaceLanguage } from './language.ts'

describe('bounded interface language preferences', () => {
  it.each(['en', 'zh-CN'] as const)('accepts only the explicit value %s', (value) => {
    expect(explicitLanguage(value)).toBe(value)
  })
  it.each([
    'EN',
    'zh',
    'zh_CN',
    'zh-TW',
    'en-US',
    '__proto__',
    'constructor',
    '',
    null,
    {},
    ['en'],
  ])('rejects unsupported explicit preferences %j', (value) => {
    expect(explicitLanguage(value)).toBeUndefined()
  })
  it.each([
    ['en-US', 'en'],
    ['en-GB', 'en'],
    ['zh', 'zh-CN'],
    ['zh-Hans', 'zh-CN'],
    ['zh-SG', 'zh-CN'],
    ['zh-Hans-CN', 'zh-CN'],
    ['zh-Hans-TW', 'zh-CN'],
    ['zh-Hans-HK', 'zh-CN'],
    ['zh-Hans-MO', 'zh-CN'],
  ])('recognizes a supported BCP47 default %s', (value, language) => {
    expect(interfaceLanguage(value)).toBe(language)
  })
  it.each([
    'zh-Hant',
    'zh-Hant-CN',
    'zh-TW',
    'zh-HK',
    'zh-MO',
    'pt-BR',
    'fa-IR',
    'th-TH',
    'en_bad',
    'x'.repeat(129),
  ])('falls through for unsupported or malformed default %s', (value) => {
    expect(interfaceLanguage(value)).toBeUndefined()
  })
  it('reads the complete cookie value without accepting suffixes or encoded lookalikes', () => {
    expect(cookieLanguage('session=irrelevant; hourmere-language=zh-CN; other=1')).toBe('zh-CN')
    for (const value of ['en=extra', 'en%00', '%65n', 'zh-CN/', ' en', 'zh_CN'])
      expect(cookieLanguage(`hourmere-language=${value}`)).toBeUndefined()
    expect(cookieLanguage(`other=${'x'.repeat(16385)}; hourmere-language=en`)).toBeUndefined()
  })
  it('respects quality values, ordering, unsupported defaults and hard bounds', () => {
    expect(acceptLanguage('fr,zh-CN;q=0.8,en;q=0.6')).toBe('zh-CN')
    expect(acceptLanguage('zh-CN;q=0,en-US;q=0.8')).toBe('en')
    expect(acceptLanguage('zh-CN;q=broken,en;q=0.5')).toBe('en')
    expect(acceptLanguage('zh-Hant,zh-TW,pt-BR')).toBe('en')
    expect(acceptLanguage('zh-CN;q=0.9,en;q=0.9')).toBe('zh-CN')
    expect(acceptLanguage(`${'xx,'.repeat(32)}zh-CN`)).toBe('en')
    expect(acceptLanguage(`zh-CN${' '.repeat(4096)}`)).toBe('en')
    expect(acceptLanguage(undefined)).toBe('en')
  })
})
