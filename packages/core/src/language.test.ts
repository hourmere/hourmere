import { describe, expect, it, vi } from 'vitest'
import {
  acceptLanguage,
  cookieLanguage,
  createLocaleResolver,
  explicitLanguage,
  formattingLocale,
  interfaceLanguage,
  interfaceLanguages,
  localeCodes,
  localeFallbacks,
  localeRegistry,
  registeredLocales,
  resolveAdminLanguage,
} from './language.ts'

describe('shared locale registry', () => {
  it('offers public translations independently of admin and notification languages', () => {
    expect(interfaceLanguages('public')).toEqual(['en', 'zh-CN', 'de', 'fr'])
    expect(interfaceLanguages('admin')).toEqual(['en', 'zh-CN'])
    expect(acceptLanguage('de-CH,zh-CN;q=0.8,en;q=0.5', 'admin')).toBe('zh-CN')
    expect(acceptLanguage('de-CH,zh-CN;q=0.8,en;q=0.5', 'public')).toBe('de')
    expect(localeFallbacks('de')).toEqual(['de', 'en'])
    expect(acceptLanguage('fr-CA,zh-CN;q=0.8,en;q=0.5', 'admin')).toBe('zh-CN')
    expect(acceptLanguage('fr-CA,zh-CN;q=0.8,en;q=0.5', 'public')).toBe('fr')
    expect(localeFallbacks('fr')).toEqual(['fr', 'en'])
    const fixture = createLocaleResolver({
      ...localeRegistry,
      qaa: {
        code: 'qaa',
        nativeName: 'Fixture',
        fallbacks: ['en'],
        formatLocale: 'fr-FR',
        direction: 'ltr',
        interfaces: ['admin'],
      },
    })
    expect(fixture.interfaceLanguages('public')).not.toContain('qaa')
    expect(fixture.interfaceLanguages('admin')).toContain('qaa')
    expect(fixture.acceptLanguage('qaa')).toBe('qaa')
  })

  it.each(['de', 'de-DE', 'de-AT', 'de-CH'])(
    'negotiates %s and formats German dates through registry metadata',
    (value) => {
      expect(interfaceLanguage(value)).toBe('de')
      expect(acceptLanguage(`qaa,${value};q=0.8,en;q=0.5`)).toBe('de')
      expect(
        new Intl.DateTimeFormat(formattingLocale('de'), {
          calendar: 'gregory',
          timeZone: 'UTC',
          dateStyle: 'long',
          timeStyle: 'short',
        }).format(new Date('2026-10-27T15:30:00Z')),
      ).toBe('27. Oktober 2026 um 15:30')
    },
  )

  it.each(['fr', 'fr-FR', 'fr-CA', 'fr-BE', 'fr-CH'])(
    'negotiates %s and formats French dates through registry metadata',
    (value) => {
      expect(interfaceLanguage(value)).toBe('fr')
      expect(acceptLanguage(`qaa,${value};q=0.8,en;q=0.5`)).toBe('fr')
      expect(
        new Intl.DateTimeFormat(formattingLocale('fr'), {
          calendar: 'gregory',
          timeZone: 'UTC',
          dateStyle: 'long',
          timeStyle: 'short',
        }).format(new Date('2026-10-27T15:30:00Z')),
      ).toBe('27 octobre 2026 à 15:30')
    },
  )

  it('provides language metadata and explicit choices from the same entries', () => {
    expect(localeCodes).toEqual(Object.keys(localeRegistry))
    expect(registeredLocales).toEqual(Object.values(localeRegistry))
    for (const locale of registeredLocales) {
      expect(explicitLanguage(locale.code)).toBe(locale.code)
      expect(locale.nativeName).not.toBe('')
      expect(locale.direction).toBe('ltr')
      expect(new Intl.Locale(locale.formatLocale).baseName).toBe(locale.formatLocale)
    }
    expect(localeFallbacks('en')).toEqual(['en'])
    expect(localeFallbacks('zh-CN')).toEqual(['zh-CN', 'en'])
  })

  it('uses registry Intl locales without changing the existing English or Chinese formats', () => {
    const instant = new Date('2026-10-27T15:30:00Z')
    const options = {
      timeZone: 'America/Los_Angeles',
      dateStyle: 'long',
      timeStyle: 'short',
    } as const
    expect(new Intl.DateTimeFormat(formattingLocale('en'), options).format(instant)).toBe(
      'October 27, 2026 at 8:30 AM',
    )
    expect(new Intl.DateTimeFormat(formattingLocale('zh-CN'), options).format(instant)).toBe(
      '2026年10月27日 08:30',
    )
  })

  it('accepts another registered regional locale throughout preference resolution and formatting', () => {
    const languages = createLocaleResolver({
      ...localeRegistry,
      'pt-BR': {
        code: 'pt-BR',
        nativeName: 'Português (Brasil)',
        fallbacks: [],
        formatLocale: 'pt-BR',
        direction: 'ltr',
      },
      'pt-PT': {
        code: 'pt-PT',
        nativeName: 'Português (Portugal)',
        fallbacks: ['pt-BR', 'pt-BR', 'en', 'en'],
        formatLocale: 'pt-PT',
        direction: 'ltr',
      },
    })
    expect(languages.explicitLanguage('pt-BR')).toBe('pt-BR')
    expect(languages.explicitLanguage('PT-br')).toBeUndefined()
    expect(languages.interfaceLanguage('PT-br')).toBe('pt-BR')
    expect(languages.interfaceLanguage('pt')).toBe('pt-BR')
    expect(languages.interfaceLanguage('pt-AO')).toBe('pt-BR')
    expect(languages.interfaceLanguage('pt-Cyrl')).toBeUndefined()
    expect(languages.interfaceLanguage('pt-PT-u-ca-gregory')).toBe('pt-PT')
    expect(languages.cookieLanguage('hourmere-language=pt-BR')).toBe('pt-BR')
    expect(languages.acceptLanguage('pt-PT;q=0.5,pt-BR;q=0.9,en;q=0.8')).toBe('pt-BR')
    expect(languages.localeFallbacks('pt-BR')).toEqual(['pt-BR', 'en'])
    expect(languages.localeFallbacks('pt-PT')).toEqual(['pt-PT', 'pt-BR', 'en'])
    expect(languages.registeredLocales.map((locale) => locale.code)).toEqual([
      ...new Set([...Object.keys(localeRegistry), 'pt-BR', 'pt-PT']),
    ])
    expect(
      new Intl.DateTimeFormat(languages.formattingLocale('pt-BR'), {
        timeZone: 'America/Los_Angeles',
        dateStyle: 'long',
        timeStyle: 'short',
      }).format(new Date('2026-10-27T15:30:00Z')),
    ).toBe('27 de outubro de 2026 às 08:30')
  })

  it('takes regional and script exclusions from the registered locale', () => {
    const languages = createLocaleResolver({
      ...localeRegistry,
      'zh-CN': {
        ...localeRegistry['zh-CN'],
        excludedRegions: ['US'],
        excludedScripts: ['Latn'],
      },
    })
    expect(languages.interfaceLanguage('zh-US')).toBeUndefined()
    expect(languages.interfaceLanguage('zh-Latn')).toBeUndefined()
    expect(languages.interfaceLanguage('zh-TW')).toBe('zh-CN')
    expect(languages.interfaceLanguage('zh-Hant')).toBe('zh-CN')
  })
})

describe('bounded interface language preferences', () => {
  it.each(['en', 'zh-CN', 'de', 'fr'] as const)('accepts only the explicit value %s', (value) => {
    expect(explicitLanguage(value)).toBe(value)
  })
  it.each([
    'EN',
    'zh',
    'zh_CN',
    'zh-TW',
    'en-US',
    'fr-CA',
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
    ['en-Shaw', 'en'],
    ['en-Cyrl', 'en'],
    ['zh', 'zh-CN'],
    ['zh-Hans', 'zh-CN'],
    ['zh-US', 'zh-CN'],
    ['zh-AU', 'zh-CN'],
    ['zh-GB', 'zh-CN'],
    ['zh-ID', 'zh-CN'],
    ['zh-TH', 'zh-CN'],
    ['zh-PH', 'zh-CN'],
    ['zh-VN', 'zh-CN'],
    ['zh-SG', 'zh-CN'],
    ['zh-Latn', 'zh-CN'],
    ['zh-Bopo', 'zh-CN'],
    ['zh-Hans-CN', 'zh-CN'],
  ])('recognizes a supported BCP47 default %s', (value, language) => {
    expect(interfaceLanguage(value)).toBe(language)
  })
  it.each([
    'zh-Hant',
    'zh-Hant-CN',
    'zh-TW',
    'zh-HK',
    'zh-MO',
    'zh-Hans-TW',
    'zh-Hans-HK',
    'zh-Hans-MO',
    'qab-BR',
    'fa-IR',
    'th-TH',
    'en_bad',
    'x'.repeat(129),
  ])('falls through for unsupported or malformed default %s', (value) => {
    expect(interfaceLanguage(value)).toBeUndefined()
  })
  it.each(['Hans', 'Hant'])('ignores regional CLDR script defaults of %s', (script) => {
    const maximize = Intl.Locale.prototype.maximize
    const regionalDefaults = vi
      .spyOn(Intl.Locale.prototype, 'maximize')
      .mockImplementation(function (this: Intl.Locale) {
        return this.language === 'zh' && this.region
          ? new Intl.Locale(`zh-${script}-${this.region}`)
          : maximize.call(this)
      })
    try {
      for (const tag of ['zh', 'zh-US', 'zh-AU', 'zh-GB', 'zh-SG', 'zh-Latn', 'zh-Bopo'])
        expect(interfaceLanguage(tag), tag).toBe('zh-CN')
      for (const tag of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-CN', 'zh-Hans-TW'])
        expect(interfaceLanguage(tag), tag).toBeUndefined()
      expect(acceptLanguage('zh-AU,en;q=0.5')).toBe('zh-CN')
      expect(acceptLanguage('qaa,zh-US;q=0.5')).toBe('zh-CN')
    } finally {
      regionalDefaults.mockRestore()
    }
  })
  it('reads the complete cookie value without accepting suffixes or encoded lookalikes', () => {
    expect(cookieLanguage('session=irrelevant; hourmere-language=zh-CN; other=1')).toBe('zh-CN')
    for (const value of ['en=extra', 'en%00', '%65n', 'zh-CN/', ' en', 'zh_CN'])
      expect(cookieLanguage(`hourmere-language=${value}`)).toBeUndefined()
    expect(cookieLanguage(`other=${'x'.repeat(16385)}; hourmere-language=en`)).toBeUndefined()
  })
  it('respects quality values, ordering, unsupported defaults and hard bounds', () => {
    expect(acceptLanguage('zh-AU,en;q=0.5')).toBe('zh-CN')
    expect(acceptLanguage('qaa,zh-US;q=0.5')).toBe('zh-CN')
    expect(acceptLanguage('qab,zh-CN;q=0.8,en;q=0.6')).toBe('zh-CN')
    expect(acceptLanguage('zh-CN;q=0,en-US;q=0.8')).toBe('en')
    expect(acceptLanguage('zh-CN;q=broken,en;q=0.5')).toBe('en')
    expect(acceptLanguage('zh-Hant,zh-TW,qab-BR')).toBe('en')
    expect(acceptLanguage('zh-CN;q=0.9,en;q=0.9')).toBe('zh-CN')
    expect(acceptLanguage(`${'xx,'.repeat(32)}zh-CN`)).toBe('en')
    expect(acceptLanguage(`zh-CN${' '.repeat(4096)}`)).toBe('en')
    expect(acceptLanguage(undefined)).toBe('en')
  })
})

describe('server admin language precedence', () => {
  it.each([
    [{ cookie: 'hourmere-language=de', acceptLanguage: 'zh-CN' }, 'zh-CN'],
    [{ cookie: 'hourmere-language=de', acceptLanguage: 'de-CH' }, 'en'],
    [{ cookie: 'hourmere-language=de', acceptLanguage: 'de-CH,zh-CN;q=0.8' }, 'zh-CN'],
    [{ cookie: 'hourmere-language=zh-CN', accountLocale: 'en', acceptLanguage: 'en' }, 'zh-CN'],
    [{ cookie: 'hourmere-language=en', accountLocale: 'zh-CN', acceptLanguage: 'zh-CN' }, 'en'],
    [{ cookie: 'hourmere-language=de', accountLocale: 'zh-SG', acceptLanguage: 'en' }, 'zh-CN'],
    [{ cookie: 'hourmere-language=de', accountLocale: 'en-GB', acceptLanguage: 'zh-CN' }, 'en'],
    [{ accountLocale: 'de-CH', acceptLanguage: 'zh-CN' }, 'zh-CN'],
    [{ accountLocale: 'zh-TW', acceptLanguage: 'zh-CN' }, 'zh-CN'],
    [{ accountLocale: 'invalid_locale', acceptLanguage: 'zh-CN' }, 'zh-CN'],
    [{ cookie: 'hourmere-language=__proto__', acceptLanguage: 'zh-CN' }, 'zh-CN'],
    [{ acceptLanguage: 'en;q=0.2,zh-CN;q=0.9' }, 'zh-CN'],
    [{ acceptLanguage: 'zh-CN;q=0,de-CH' }, 'en'],
    [{}, 'en'],
  ] as const)('resolves %j to %s', (preferences, language) => {
    expect(resolveAdminLanguage(preferences)).toBe(language)
  })

  it('takes admin availability from the registry without using locale fallbacks', () => {
    const languages = createLocaleResolver({
      ...localeRegistry,
      de: { ...localeRegistry.de, fallbacks: ['zh-CN'] },
      qaa: {
        code: 'qaa',
        nativeName: 'Fixture',
        fallbacks: ['en'],
        formatLocale: 'fr-FR',
        direction: 'ltr',
        interfaces: ['admin'],
      },
    })
    expect(languages.resolveAdminLanguage({ cookie: 'hourmere-language=de' })).toBe('en')
    expect(
      languages.resolveAdminLanguage({ cookie: 'hourmere-language=qaa', acceptLanguage: 'en' }),
    ).toBe('qaa')
    expect(languages.resolveAdminLanguage({ accountLocale: 'qaa', acceptLanguage: 'en' })).toBe(
      'qaa',
    )
    expect(languages.resolveAdminLanguage({ acceptLanguage: 'qaa' })).toBe('qaa')
  })
})
