import { registeredLocales } from '@hourmere/core/language'
import { describe, expect, it } from 'vitest'
import { mailCatalogueProblems, mailCatalogues, mailMessage } from './catalogue.ts'
import english from './catalogues/en.json' with { type: 'json' }

describe('mail catalogue coverage', () => {
  it('uses the established Chinese register and distinct German phone recipient roles', () => {
    expect(mailMessage('zh-CN', 'phone.hostCallsYou', { number: '+14155550123' })).toBe(
      '电话通话 — 主持人将拨打你的号码 +14155550123',
    )
    expect(mailMessage('zh-CN', 'phone.inviteeCallsYou', { number: '+14155550123' })).toBe(
      '电话通话 — 预约人将拨打你的号码 +14155550123',
    )
    expect(mailMessage('zh-CN', 'phone.callInvitee', { number: '+14155550123' })).toBe(
      '电话通话 — 请拨打预约人的号码 +14155550123',
    )
    expect(mailMessage('zh-CN', 'phone.hostCallsInvitee')).toBe('电话通话 — 主持人将致电预约人')
    expect(mailMessage('de', 'phone.hostCallsInvitee')).toBe(
      'Telefonat — die gastgebende Person ruft die buchende Person an',
    )
    expect(mailMessage('de', 'phone.callInvitee', { number: '+14155550123' })).toBe(
      'Telefonat — rufen Sie die buchende Person unter +14155550123 an',
    )
    expect(mailMessage('de', 'phone.hostCallsYou', { number: '+14155550123' })).toBe(
      'Telefonat — die gastgebende Person ruft Sie unter +14155550123 an',
    )
    expect(mailMessage('de', 'phone.inviteeCallsYou', { number: '+14155550123' })).toBe(
      'Telefonat — die buchende Person ruft Sie unter +14155550123 an',
    )
    expect(mailMessage('de', 'phone.callHost', { number: '+14155550123' })).toBe(
      'Telefonat — rufen Sie die gastgebende Person unter +14155550123 an',
    )
  })

  it('names the booker in phone strings with the catalogue invitee label', () => {
    const label = { 'zh-CN': '预约人', de: 'buchende Person' } as const
    expect(mailMessage('zh-CN', 'Invitee')).toBe(label['zh-CN'])
    expect(mailMessage('de', 'Invitee')).toBe('Buchende Person')
    for (const locale of ['zh-CN', 'de'] as const)
      for (const key of [
        'phone.callInvitee',
        'phone.hostCallsInvitee',
        'phone.inviteeCallsYou',
      ] as const)
        expect(mailMessage(locale, key, { number: '+14155550123' })).toContain(label[locale])
  })

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
