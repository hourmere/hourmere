import { readFileSync } from 'node:fs'
import { registeredLocales } from '@hourmere/core/language'
import { describe, expect, it } from 'vitest'
import { errorMessage, RequestError } from '../api/errors.ts'
import { durationMessage } from '../i18n/duration.ts'
import { msg, translateMessage } from '../i18n/translate.ts'
import { failureMessage, PublicRequestError } from './api.ts'

const error = (seconds: number) =>
  new PublicRequestError(new RequestError(429, 'rate_limited', 'rate_limited'), seconds)
const source = readFileSync('apps/web/src/public/api.ts', 'utf8')
const start = source.indexOf('export function failureMessage(')
const end = source.indexOf('\nexport const codeOf', start)
const failureSource = source.slice(start, end)
function copyFailure(value: string): typeof failureMessage {
  // Run the production function body with its real formatting and error dependencies.
  const body = value.slice(value.indexOf('{') + 1, value.lastIndexOf('}'))
  return new Function(
    'PublicRequestError',
    'durationMessage',
    'msg',
    'errorMessage',
    `return function (err) {${body}}`,
  )(PublicRequestError, durationMessage, msg, errorMessage) as typeof failureMessage
}

const waits = {
  en: ['1 hour', '24 hours'],
  de: ['1 Stunde', '24 Stunden'],
  fr: ['1 heure', '24 heures'],
  es: ['1 hora', '24 horas'],
  'pt-BR': ['1 hora', '24 horas'],
  'zh-CN': ['1小时', '24小时'],
} as const

describe('public rate-limit wait durations', () => {
  it.each(registeredLocales)('formats durable waitlist limits naturally in $code', ({ code }) => {
    for (const [index, seconds] of [3600, 86400].entries()) {
      const text = translateMessage(code, failureMessage(error(seconds)))
      expect(text.replaceAll(' ', '')).toContain(waits[code][index]?.replaceAll(' ', ''))
      expect(text).not.toMatch(/3600|86400/)
      if (code === 'zh-CN') {
        expect(text).not.toContain('您')
        expect(text.endsWith('。')).toBe(true)
      }
    }
  })
  it('retains short waits and rounds up so retry hints never shorten a limit', () => {
    expect(translateMessage('en', failureMessage(error(30)))).toContain('30 seconds')
    expect(translateMessage('en', failureMessage(error(61)))).toContain('2 minutes')
    expect(translateMessage('en', failureMessage(error(3601)))).toContain('2 hours')
  })
  it('detects replacing the duration formatter with raw seconds in a production source copy', () => {
    const anchor = 'duration: durationMessage(err.retryAfter)'
    expect(failureSource.split(anchor), 'source-copy mutation must match once').toHaveLength(2)
    const check = (value: string) => {
      const format = copyFailure(value)
      for (const { code } of registeredLocales) {
        const text = translateMessage(code, format(error(86400)))
        expect(text.replaceAll(' ', '')).toContain(waits[code][1].replaceAll(' ', ''))
        expect(text).not.toContain('86400')
      }
    }
    check(failureSource)
    expect(() => check(failureSource.replace(anchor, 'duration: err.retryAfter'))).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    check(failureSource)
  })
})
