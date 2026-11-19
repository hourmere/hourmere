import { interfaceLanguages } from '@hourmere/core/language'
import { describe, expect, it } from 'vitest'
import { meetingPollCredentialEmail, meetingPollOutcomeEmail } from './meeting-polls.ts'

const base = {
  to: 'voter@example.test',
  publicUrl: 'https://hourmere.example',
  pollTitle: 'Planning <script>',
  token: 'a'.repeat(43),
  purpose: 'verification' as const,
  expiresAt: new Date('2027-02-01T10:00:00Z'),
  timeZone: 'America/Los_Angeles',
}
describe('meeting poll credential mail', () => {
  for (const language of ['en', 'zh-CN', 'de', 'es', 'fr', 'pt-BR']) {
    it(`renders sensitive localized verification and voting mail: ${language}`, () => {
      const verification = meetingPollCredentialEmail({ ...base, language })
      expect(verification.sensitive).toBe(true)
      expect(verification.html).not.toContain('<script>')
      expect(verification.text).toContain(`/poll/voter#${base.token}`)
      expect(verification.text).toContain('America/Los_Angeles')
      expect(verification.text).not.toContain('reminder-opt-out')
      expect(verification.attachments).toBeUndefined()
      const voting = meetingPollCredentialEmail({
        ...base,
        language,
        purpose: 'voting',
        optOutToken: 'b'.repeat(43),
      })
      expect(voting.text).toContain(`/poll/reminder-opt-out#${'b'.repeat(43)}`)
      expect(voting.subject).not.toEqual(verification.subject)
      expect(voting.text).not.toContain('?token=')
    })
  }
  it('refuses untrusted origins and malformed credentials without echoing them', () => {
    expect(() =>
      meetingPollCredentialEmail({ ...base, publicUrl: 'https://secret.example/path' }),
    ).toThrow('Invalid meeting poll origin')
    expect(() => meetingPollCredentialEmail({ ...base, token: 'private-invalid-value' })).toThrow(
      'Invalid meeting poll capability',
    )
  })
})

describe('meeting poll outcome mail', () => {
  const outcome = {
    to: base.to,
    pollTitle: 'Planning <script>\r\nBcc: hidden@example.test',
    startAt: new Date('2040-11-04T05:30:00Z'),
    endAt: new Date('2040-11-04T06:30:00Z'),
    timeZone: 'America/New_York',
  }

  it.each(['selected', 'rescheduled', 'cancelled'] as const)(
    'renders a localized %s notice with no links or attachments',
    (kind) => {
      const languages = interfaceLanguages('public')
      const messages = languages.map((language) => {
        const mail = meetingPollOutcomeEmail({ ...outcome, kind, language })
        expect(mail.to).toBe(outcome.to)
        expect(mail.sensitive).toBe(true)
        expect(mail.subject).toContain('Planning <script>')
        expect(mail.subject).not.toMatch(/[\r\n]/)
        expect(mail.html).toContain(`<html lang="${language}">`)
        expect(mail.html).not.toMatch(/<script>|href=/i)
        expect(mail.text).toContain('GMT-04:00')
        expect(mail.text).toContain('GMT-05:00')
        expect(mail.text).not.toMatch(/https?:\/\/|BEGIN:VCALENDAR/)
        expect(mail.attachments).toBeUndefined()
        return mail
      })
      expect(new Set(messages.map(({ subject }) => subject)).size).toBe(languages.length)
      expect(new Set(messages.map(({ text }) => text.split('\n\n')[1])).size).toBe(languages.length)
    },
  )

  it('uses the default locale when the voter locale is unavailable', () => {
    const mail = meetingPollOutcomeEmail({
      ...outcome,
      pollTitle: 'Planning',
      kind: 'selected',
      language: 'unknown',
      defaultLanguage: 'fr',
      startAt: new Date('2040-11-11T20:00:00Z'),
      endAt: new Date('2040-11-11T20:30:00Z'),
      timeZone: 'Pacific/Kiritimati',
    })
    expect(mail.subject).toBe('Créneau choisi pour Planning')
    expect(mail.text).toContain('12 novembre 2040')
    expect(mail.text).toContain('10:00')
    expect(mail.text).toContain('Pacific/Kiritimati, GMT+14:00')
  })
})
