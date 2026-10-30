import { registeredLocales } from '@hourmere/core/language'
import { describe, expect, it } from 'vitest'
import { mailCatalogueProblems, mailCatalogues, mailMessage } from './catalogue.ts'
import english from './catalogues/en.json' with { type: 'json' }

describe('mail catalogue coverage', () => {
  for (const { code } of registeredLocales) {
    it(`${code} reports coverage and has valid placeholders`, () => {
      const catalogue = mailCatalogues[code] ?? {}
      const missing = Object.keys(english).filter((key) => !Object.hasOwn(catalogue, key))
      console.info(
        `Mail ${code}: ${Object.keys(english).length - missing.length}/${Object.keys(english).length} keys`,
      )
      // Every shipped locale is complete; runtime still accepts partial future catalogues.
      expect(missing).toEqual([])
      expect(mailCatalogueProblems(catalogue)).toEqual([])
    })
  }

  it('rejects malformed, added, missing and renamed placeholders in partial catalogues', () => {
    for (const translation of [
      'Fixture {event',
      'Fixture {other}',
      'Fixture',
      'Fixture {event} {extra}',
    ]) {
      expect(
        mailCatalogueProblems({ 'Meeting link needs attention: {event} on {when}': translation }),
      ).toEqual([
        'Meeting link needs attention: {event} on {when}: malformed or mismatched placeholders',
      ])
    }
    expect(mailCatalogueProblems({ unknown: 'Fixture' })).toEqual(['unknown: unknown key'])
  })

  it('preserves literal user placeholders while substituting known names once', () => {
    expect(mailMessage('en', 'calendar.summary', { event: '{other}', other: 'Ada' })).toBe(
      '{other} with Ada',
    )
    expect(mailMessage('zh-CN', 'calendar.summary', { event: '{other}', other: 'Ada' })).toBe(
      '{other}（与 Ada）',
    )
    expect(mailMessage('fr', 'calendar.summary', { event: '{other}', other: 'Ada' })).toBe(
      '{other} avec Ada',
    )
  })
})

describe('Spanish mail punctuation', () => {
  const texts = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(texts)
        : []

  it('opens every Spanish mail question and exclamation', () => {
    for (const translation of texts(mailCatalogues.es))
      for (const sentence of translation.match(/[^.!?]*[?!]/gu) ?? [])
        expect(sentence, translation).toMatch(sentence.endsWith('?') ? /¿[^¿]*\?$/u : /¡[^¡]*!$/u)
  })
})
