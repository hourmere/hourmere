import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import '../i18n/admin.ts'
import { localeRegistry } from '@hourmere/core/locales'
import { literal, msg, translateMessage } from '../i18n/translate.ts'
import * as errors from './errors.ts'

const conflict =
  'The saved location options cannot be changed here. Keep the location unchanged and try again.'
const unavailable = 'This location is unavailable. Contact the host to book.'
const translations = {
  en: unavailable,
  'zh-CN': '此地点暂时无法预约。请联系主持人安排预约。',
  de: 'Dieser Treffpunkt ist nicht verfügbar. Wenden Sie sich für die Buchung an die gastgebende Person.',
  fr: 'Ce lieu de rendez-vous est indisponible. Contactez l’hôte pour réserver.',
  es: 'Esta ubicación no está disponible. Contacta con el anfitrión para reservar.',
  'pt-BR': 'Este local não está disponível. Entre em contato com o anfitrião para agendar.',
} as const

type ErrorFunctions = Pick<typeof errors, 'errorMessage' | 'requestError'>

function verifyConflict(api: ErrorFunctions) {
  const message = api.errorMessage(
    api.requestError(409, { error: 'location_options_conflict', message: 'Raw server detail.' }),
  )
  expect(translateMessage('en', message)).toBe(conflict)
  expect(translateMessage('zh-CN', message)).toBe(
    '无法在此处更改已保存的地点选项。请保留原地点后重试。',
  )
}

function verifyPhone(api: ErrorFunctions) {
  expect(Object.keys(translations)).toEqual(Object.keys(localeRegistry))
  const message = api.errorMessage(
    api.requestError(400, { error: 'invalid_invitee_phone', message: 'Raw server detail.' }),
  )
  for (const [locale, translated] of Object.entries(translations))
    expect(translateMessage(locale as keyof typeof translations, message)).toBe(translated)
}

function sourceCopy(code?: string): ErrorFunctions {
  const original = readFileSync('apps/web/src/api/errors.ts', 'utf8')
  let source = original
  if (code) {
    source = source.replace(new RegExp(`    ${code}:[\\s\\S]*?,\\n`), '')
    expect(source).not.toBe(original)
  }
  source = stripTypeScriptTypes(source)
    .replace(/^import .*\n/gm, '')
    .replace(/\bexport /g, '')
  return new Function('literal', 'msg', `${source}; return {errorMessage, requestError}`)(
    literal,
    msg,
  ) as ErrorFunctions
}

describe('location errors in the current interfaces', () => {
  it('localizes legacy option conflicts for administrators', () => verifyConflict(errors))
  it('uses neutral translated guidance in every public language until phone collection ships', () =>
    verifyPhone(errors))
  it.each([
    ['location_options_conflict', verifyConflict],
    ['invalid_invitee_phone', verifyPhone],
  ] as const)('detects removal of the %s localization in a source copy', (code, verify) => {
    verify(sourceCopy())
    expect(() => verify(sourceCopy(code))).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    verify(sourceCopy())
  })
})
