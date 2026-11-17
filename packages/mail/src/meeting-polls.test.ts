import { describe, expect, it } from 'vitest'
import { meetingPollCredentialEmail } from './meeting-polls.ts'

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
