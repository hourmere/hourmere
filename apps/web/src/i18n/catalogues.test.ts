import { registeredLocales } from '@hourmere/core/language'
import { describe, expect, it } from 'vitest'
import { type Catalog, catalogueCoverage } from './catalogues.ts'

const groups = {
  common: import.meta.glob<Catalog>('./catalogues/*/common.ts', { eager: true, import: 'common' }),
  admin: import.meta.glob<Catalog>('./catalogues/*/admin.ts', { eager: true, import: 'admin' }),
  widget: import.meta.glob<Catalog>('./catalogues/*/widget.ts', { eager: true, import: 'widget' }),
}

describe('catalogue coverage and interpolation', () => {
  for (const { code } of registeredLocales)
    it(`reports ${code} coverage and validates every translated placeholder`, () => {
      for (const [group, modules] of Object.entries(groups)) {
        const english = modules[`./catalogues/en/${group}.ts`] ?? {}
        expect(Object.keys(english).length).toBeGreaterThan(0)
        const translated = modules[`./catalogues/${code}/${group}.ts`] ?? {}
        const coverage = catalogueCoverage(english, translated)
        console.info(`${code}/${group}: ${coverage.translated}/${coverage.total} messages`)
        expect(coverage.malformed, `${code}/${group}: malformed placeholders`).toEqual([])
        if (code === 'en' || code === 'zh-CN') expect(coverage.missing).toEqual([])
        else if (coverage.missing.length)
          console.warn(`${code}/${group}: ${coverage.missing.length} messages fall back to English`)
      }
    })

  it('allows partial translations while rejecting missing, added and malformed placeholders', () => {
    const english = { greeting: 'Hello {name}', count: '{count} times', absent: 'English fallback' }
    expect(catalogueCoverage(english, { greeting: 'Welcome {name}' })).toEqual({
      total: 3,
      translated: 1,
      missing: ['count', 'absent'],
      malformed: [],
    })
    for (const greeting of [
      'Hello',
      'Hello {other}',
      'Hello {name} {name}',
      'Hello {name',
      'Hello {name} }',
    ])
      expect(catalogueCoverage(english, { greeting }).malformed).toEqual(['greeting'])
  })
})
