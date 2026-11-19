import { registeredLocales } from '@hourmere/core/language'
import { describe, expect, it } from 'vitest'
import {
  meetingPollCredentialEmail,
  meetingPollDeadlineEmail,
  meetingPollReminderEmail,
} from './meeting-polls.ts'

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
  for (const { code: language } of registeredLocales) {
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
    it(`renders a distinct reminder with direct voting and opt-out links: ${language}`, () => {
      const optOutToken = 'b'.repeat(43)
      const reminder = meetingPollReminderEmail({ ...base, language, optOutToken })
      const invitation = meetingPollCredentialEmail({ ...base, language, purpose: 'voting' })
      expect(reminder.sensitive).toBe(true)
      expect(reminder.subject).not.toEqual(invitation.subject)
      expect(reminder.text).toContain(`/poll/voter#${base.token}`)
      expect(reminder.text).toContain(`/poll/reminder-opt-out#${optOutToken}`)
      expect(reminder.html).not.toContain('<script>')
      expect(reminder.attachments).toBeUndefined()
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

describe('meeting poll deadline notice', () => {
  const options = {
    to: 'host@example.test',
    publicUrl: base.publicUrl,
    pollTitle: base.pollTitle,
    pollId: '6b1bb090-4ac4-4d2c-8af6-ad75c5369701',
    deadlineAt: base.expiresAt,
    timeZone: base.timeZone,
    responseCount: 7,
  }
  it('renders the title, deadline in the profile zone and count with an authenticated results URL', () => {
    const notice = meetingPollDeadlineEmail(options)
    const url = `${options.publicUrl}/api/v1/meeting-polls/${options.pollId}/results`
    expect(notice.sensitive).toBe(true)
    expect(notice.to).toBe(options.to)
    expect(notice.subject).toContain(options.pollTitle)
    expect(notice.text).toContain('2:00')
    expect(notice.text).toContain(`(${options.timeZone})`)
    expect(notice.text).toContain('The total number of responses received is 7.')
    expect(notice.text.match(/https?:\/\/\S+/g)).toEqual([url])
    expect(notice.html).toContain(`href="${url}"`)
    expect(notice.html).not.toContain('<script>')
    expect(notice.attachments).toBeUndefined()
  })

  it('refuses malformed poll IDs before constructing the results link', () => {
    expect(() => meetingPollDeadlineEmail({ ...options, pollId: 'fixture#fragment' })).toThrow(
      'Invalid meeting poll ID',
    )
  })
})
