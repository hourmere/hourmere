import { localeCodes } from '@hourmere/core/language'
import { describe, expect, it } from 'vitest'
import { mailboxProofEmail } from './index.ts'

const url = 'https://hourmere.example.test/app/mailbox-proof#attempt=a&token=b<c>'

describe('SSO mailbox proof email', () => {
  it('links the inert page, states the expiry and escapes the link in HTML', () => {
    const message = mailboxProofEmail({ to: 'ada@example.test', url, expiresInMinutes: 5 })
    expect(message.to).toBe('ada@example.test')
    expect(message.subject).toBe('Confirm your email address for Hourmere')
    expect(message.text).toContain(url)
    expect(message.text).toContain('expires in 5 minutes')
    expect(message.html).toContain('token=b&lt;c&gt;')
    expect(message.html).not.toContain('b<c>')
  })

  it('names no account, team or provider in any language', () => {
    for (const language of localeCodes) {
      const message = mailboxProofEmail({
        to: 'x@example.test',
        url,
        expiresInMinutes: 5,
        language,
      })
      expect(message.subject.length).toBeGreaterThan(0)
      expect(`${message.subject}\n${message.text}`).not.toMatch(
        /account|Konto|cuenta|compte|conta|账号|账户|team|SSO|provider/i,
      )
    }
    expect(
      mailboxProofEmail({ to: 'x@example.test', url, expiresInMinutes: 3, language: 'zh-CN' })
        .subject,
    ).toBe('为 Hourmere 确认你的电子邮件地址')
  })
})
