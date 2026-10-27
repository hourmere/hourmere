import { describe, expect, it } from 'vitest'
import { createLogMailer, teamInvitationEmail } from './index.ts'

const invitation = {
  to: 'invited+team@example.test',
  publicUrl: 'https://calendar.example.test',
  invitationId: '019a278e-3ff2-7a91-8fe0-1846a52d0b22',
  teamName: 'Orbital Design',
  inviterName: 'Ada Lovelace',
  expiresAt: '2026-10-29T17:30:00.000Z',
}
const acceptLink = `${invitation.publicUrl}/app/join?invitationId=${invitation.invitationId}`

/** Compare visible facts independently of the template's HTML text and quote helpers. */
function visibleText(html: string): string {
  return html
    .replace(/<head>[\s\S]*?<\/head>/i, '')
    .replace(/<[^>]*>/g, ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
}

function links(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((match) => match[1] ?? '')
}

function renderError(options: Parameters<typeof teamInvitationEmail>[0]): Error {
  let caught: unknown
  try {
    teamInvitationEmail(options)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(Error)
  return caught as Error
}

describe('teamInvitationEmail', () => {
  // Captured before moving the original English/Chinese copy into locale tables.
  it.each(['en', 'zh-CN'])('preserves the complete %s message bytes', (language) => {
    expect(teamInvitationEmail({ ...invitation, language })).toMatchSnapshot()
    expect(
      teamInvitationEmail({ ...invitation, language, teamName: '', inviterName: '' }),
    ).toMatchSnapshot()
  })

  it.each([
    {
      language: 'en',
      subject: 'Invitation to join Orbital Design',
      identity: /Sign in with the invited email address .* and verify it/,
      acceptance: /Signing in alone does not join the team; you must explicitly accept/,
      expiry: /This invitation expires at 2026-10-29 17:30:00 UTC/,
      aliases: /Email aliases cannot replace this address/,
      action: 'View and accept invitation',
    },
    {
      language: 'zh-CN',
      subject: '邀请你加入团队：Orbital Design',
      identity: /请使用受邀邮箱 .* 登录并完成邮箱验证/,
      acceptance: /仅登录不会加入团队；你需要在页面上明确接受邀请/,
      expiry: /邀请有效期至：2026-10-29 17:30:00 UTC/,
      aliases: /邮箱别名不能代替此地址/,
      action: '查看并接受邀请',
    },
    {
      language: 'de',
      subject: 'Einladung zum Team Orbital Design',
      identity:
        /Melden Sie sich mit der eingeladenen E-Mail-Adresse .* an und bestätigen Sie diese/,
      acceptance: /Durch die Anmeldung allein treten Sie dem Team nicht bei/,
      expiry: /Diese Einladung ist bis 2026-10-29 17:30:00 UTC gültig/,
      aliases: /E-Mail-Aliasse können diese Adresse nicht ersetzen/,
      action: 'Einladung ansehen und annehmen',
    },
  ])('renders the complete $language invitation in both alternatives', (copy) => {
    const message = teamInvitationEmail({ ...invitation, language: copy.language })
    expect(message.to).toBe(invitation.to)
    expect(message.sensitive).toBe(true)
    expect(message.subject).toBe(copy.subject)
    expect(message.html).toContain(`<html lang="${copy.language}">`)
    const html = visibleText(message.html ?? '')
    for (const body of [message.text, html]) {
      for (const fact of [invitation.teamName, invitation.inviterName, invitation.to]) {
        expect(body).toContain(fact)
      }
      expect(body).toMatch(copy.identity)
      expect(body).toMatch(copy.acceptance)
      expect(body).toMatch(copy.expiry)
      expect(body).toMatch(copy.aliases)
      expect(body).toContain(copy.action)
      expect(body).toContain(acceptLink)
    }
    expect(links(message.html ?? '')).toEqual([acceptLink, acceptLink])
    expect(message.text.match(/https?:\/\/\S+/g)).toEqual([acceptLink])
    expect(new URL(acceptLink).pathname).toBe('/app/join')
    expect([...new URL(acceptLink).searchParams]).toEqual([
      ['invitationId', invitation.invitationId],
    ])
  })

  it.each([
    { language: 'zh', defaultLanguage: 'en', expected: 'zh-CN' },
    { language: 'zh-SG', defaultLanguage: 'en', expected: 'zh-CN' },
    // The registry excludes TW even when the tag explicitly requests Simplified Chinese.
    { language: 'zh-Hans-TW', defaultLanguage: 'en', expected: 'en' },
    { language: 'en-GB', defaultLanguage: 'zh-CN', expected: 'en' },
    { language: 'EN-us', defaultLanguage: 'zh-CN', expected: 'en' },
    { language: 'de-AT', defaultLanguage: 'en', expected: 'de' },
    { language: 'de-CH', defaultLanguage: 'zh-CN', expected: 'de' },
    { language: 'not_a_locale', defaultLanguage: 'de-CH', expected: 'de' },
    { language: 'fr', defaultLanguage: 'zh-CN', expected: 'zh-CN' },
    { language: 'zh-TW', defaultLanguage: 'zh-Hans', expected: 'zh-CN' },
    { language: 'zh-Hant-CN', defaultLanguage: 'en', expected: 'en' },
    { language: null, defaultLanguage: 'zh-CN', expected: 'zh-CN' },
    { language: undefined, defaultLanguage: 'zh-CN', expected: 'zh-CN' },
    { language: 42, defaultLanguage: 'zh-CN', expected: 'zh-CN' },
    { language: {}, defaultLanguage: 'zh-CN', expected: 'zh-CN' },
    { language: 'not_a_locale', defaultLanguage: 'fr', expected: 'en' },
    { language: 'zh-Hant', defaultLanguage: 'zh-HK', expected: 'en' },
    { language: 'z'.repeat(129), defaultLanguage: null, expected: 'en' },
    { language: undefined, defaultLanguage: undefined, expected: 'en' },
  ])(
    'selects $expected from inviter $language then instance $defaultLanguage then English',
    ({ language, defaultLanguage, expected }) => {
      expect(teamInvitationEmail({ ...invitation, language, defaultLanguage })).toEqual(
        teamInvitationEmail({ ...invitation, language: expected }),
      )
    },
  )

  it.each(['en', 'zh-CN'])(
    'ignores supplied accept links and callbacks while rendering %s',
    (language) => {
      const options = {
        ...invitation,
        language,
        acceptUrl: 'https://outside.example.test/accept?token=external',
        callbackURL: 'https://outside.example.test/?language=zh-CN',
        redirectTo: '//outside.example.test',
      }
      const message = teamInvitationEmail(options)
      expect(message).toEqual(teamInvitationEmail({ ...invitation, language }))
      expect(message.text).not.toContain('outside.example.test')
      expect(message.html).not.toMatch(/callbackURL|redirectTo|[?&]language=/)
    },
  )

  it('treats a URL-shaped language as unsupported rather than as a callback', () => {
    const message = teamInvitationEmail({
      ...invitation,
      language: 'https://outside.example.test/?language=zh-CN',
      defaultLanguage: 'zh-CN',
    })
    expect(message).toEqual(teamInvitationEmail({ ...invitation, language: 'zh-CN' }))
    expect(message.html).not.toContain('outside.example.test')
  })

  it.each([
    'https://calendar.example.test',
    'https://calendar.example.test/',
    'https://calendar.example.test:8443',
    'http://localhost:46071/',
    'http://[::1]:46071',
  ])('builds every link from configured origin %s', (publicUrl) => {
    const message = teamInvitationEmail({ ...invitation, publicUrl })
    const expected = `${new URL(publicUrl).origin}/app/join?invitationId=${invitation.invitationId}`
    expect(links(message.html ?? '')).toEqual([expected, expected])
    expect(message.text.match(/https?:\/\/\S+/g)).toEqual([expected])
  })

  it.each([
    '',
    '//outside.example.test',
    'ftp://calendar.example.test',
    'javascript:alert(1)',
    'data:text/html,<a href=https://outside.example.test>accept</a>',
    'https://',
    'https:outside.example.test',
    'https://operator:password@calendar.example.test',
    'https://calendar.example.test@outside.example.test',
    'https://calendar.example.test/app/join',
    'https://calendar.example.test//outside.example.test',
    'https://calendar.example.test/.',
    'https://calendar.example.test/%2e%2e',
    'https://calendar.example.test/?callbackURL=https://outside.example.test',
    'https://calendar.example.test?',
    'https://calendar.example.test/#https://outside.example.test',
    'https://calendar.example.test#',
    'https://calendar.example.test\\@outside.example.test',
    ' https://calendar.example.test',
    'https://calendar.example.test ',
    'https://calendar.example.test\r\n',
    'https://calen\tdar.example.test',
    'https://calendar.example.test/\u202e',
    'HTTPS://calendar.example.test',
    'https://CALENDAR.example.test',
    'https://calendar.example.test:443',
  ])('rejects non-origin or noncanonical configuration %j without leaking it', (publicUrl) => {
    const error = renderError({ ...invitation, publicUrl })
    expect(error.message).toBe('Invalid invitation instance origin')
    expect(error.cause).toBeUndefined()
    expect(JSON.stringify(error)).not.toContain(publicUrl || 'outside.example.test')
  })

  it.each([
    '',
    'not-a-uuid',
    'https://outside.example.test/accept',
    '//outside.example.test',
    `../${invitation.invitationId}`,
    `${invitation.invitationId}&callbackURL=https://outside.example.test`,
    `${invitation.invitationId}?language=zh-CN`,
    `${invitation.invitationId}#https://outside.example.test`,
    `${invitation.invitationId}%26callbackURL=external`,
    `${invitation.invitationId}\r\nBcc: victim@example.test`,
    ` ${invitation.invitationId}`,
    `${invitation.invitationId}\n`,
  ])('rejects a malformed invitation ID %j without echoing it', (invitationId) => {
    const error = renderError({ ...invitation, invitationId })
    expect(error.message).toBe('Invalid invitation ID')
    expect(error.cause).toBeUndefined()
    expect(JSON.stringify(error)).not.toContain(invitationId || 'outside.example.test')
  })

  it.each([
    new Date('2026-10-29T17:30:00.000Z'),
    '2026-10-29T17:30:00Z',
    '2026-10-29T10:30:00-07:00',
  ])('renders Better Auth expiry %s as the same UTC instant', (expiresAt) => {
    const message = teamInvitationEmail({ ...invitation, expiresAt })
    expect(message).toEqual(teamInvitationEmail(invitation))
    expect(message.text).toContain('2026-10-29 17:30:00 UTC')
    expect(message.html).toContain('2026-10-29 17:30:00 UTC')
  })

  it.each([
    '',
    'not-a-date',
    '2026-10-29',
    '2026-10-29T17:30:00',
    '2026-02-30T17:30:00Z',
    'https://outside.example.test/?token=expiry-marker',
    new Date(Number.NaN),
  ])('rejects invalid expiry %s with an input-free error', (expiresAt) => {
    const error = renderError({ ...invitation, expiresAt })
    expect(error.message).toBe('Invalid invitation expiry')
    expect(error.cause).toBeUndefined()
    expect(error.message).not.toContain('outside.example.test')
    expect(error.message).not.toContain('expiry-marker')
  })

  it.each(['en', 'zh-CN'])('escapes every user-controlled HTML fact in %s', (language) => {
    const message = teamInvitationEmail({
      ...invitation,
      language,
      teamName: '<script>alert("team")</script> & \'research\'',
      inviterName: '<img src=x onerror="alert(1)"> & O\'Hara',
      to: "o'hara&team@example.test",
    })
    expect(message.html).not.toMatch(/<script|<img|<iframe/i)
    expect(message.html).toContain('&lt;script&gt;alert(&quot;team&quot;)&lt;/script&gt;')
    expect(message.html).toContain('&amp; &#39;research&#39;')
    expect(message.html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
    expect(message.html).toContain('O&#39;Hara')
    expect(message.html).toContain('o&#39;hara&amp;team@example.test')
    for (const body of [message.text, visibleText(message.html ?? '')]) {
      expect(body).toContain('<script>alert("team")</script> & \'research\'')
      expect(body).toContain('<img src=x onerror="alert(1)"> & O\'Hara')
      expect(body).toContain("o'hara&team@example.test")
    }
    expect(links(message.html ?? '')).toEqual([acceptLink, acceptLink])
  })

  it.each(['en', 'zh-CN'])(
    'normalizes hostile display controls and malformed Unicode in %s',
    (language) => {
      const message = teamInvitationEmail({
        ...invitation,
        language,
        teamName: '  Orbital\r\nBcc: attacker@example.test\u0000\u202e Squad\ud800  ',
        inviterName: '\tAda\u0085\u2028\u2066Lovelace\udfff\n',
      })
      for (const body of [message.subject, message.text, message.html ?? '']) {
        expect(body).not.toMatch(
          // biome-ignore lint/suspicious/noControlCharactersInRegex: hostile display controls
          /[\r\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/,
        )
        expect(body.isWellFormed()).toBe(true)
      }
      expect(message.subject).not.toContain('\n')
      for (const body of [message.text, visibleText(message.html ?? '')]) {
        expect(body).toContain('Orbital Bcc: attacker@example.test Squad�')
        expect(body).toContain('Ada Lovelace�')
      }
    },
  )

  it.each([
    { language: 'en', teamName: `${'x'.repeat(179)}😀 trailing team name` },
    { language: 'zh-CN', teamName: `${'x'.repeat(190)}😀 trailing team name` },
  ])(
    'keeps a truncated $language subject well formed and the complete team in both bodies',
    (copy) => {
      const message = teamInvitationEmail({ ...invitation, ...copy })
      expect(message.subject.length).toBeLessThanOrEqual(200)
      expect(message.subject.endsWith('…')).toBe(true)
      expect(message.subject.isWellFormed()).toBe(true)
      for (const body of [message.text, visibleText(message.html ?? '')]) {
        expect(body).toContain(copy.teamName)
      }
    },
  )

  it.each(['en', 'zh-CN'])(
    'preserves the complete invited email address exactly in %s',
    (language) => {
      const to = 'Invited.Person+Team@Example.TEST'
      const message = teamInvitationEmail({ ...invitation, language, to })
      expect(message.to).toBe(to)
      for (const body of [message.text, visibleText(message.html ?? '')]) {
        expect(body).toContain(to)
        expect(body).not.toContain('invited.person+team@example.test')
      }
    },
  )

  it.each([
    { language: 'en', team: 'Your team', inviter: 'A team member' },
    { language: 'zh-CN', team: '你的团队', inviter: '团队成员' },
    { language: 'de', team: 'Ihr Team', inviter: 'Ein Teammitglied' },
  ])('uses localized anonymous display labels in $language', ({ language, team, inviter }) => {
    const message = teamInvitationEmail({
      ...invitation,
      language,
      teamName: ' \r\n\u0000\u202e ',
      inviterName: '\t\u0085\u2028\u2066 ',
    })
    expect(message.subject).toContain(team)
    for (const body of [message.text, visibleText(message.html ?? '')]) {
      expect(body).toContain(team)
      expect(body).toContain(inviter)
      expect(body).toContain(invitation.to)
    }
  })

  it.each([
    '',
    ' invited@example.test',
    'invited@example.test ',
    'invited@example.test\r\nBcc: attacker@example.test',
    'invited\u0000@example.test',
    'invited\u202e@example.test',
    'invited\ud800@example.test',
  ])('refuses an invited address that cannot be displayed unchanged: %j', (to) => {
    const error = renderError({ ...invitation, to })
    expect(error.message).toBe('Invalid invitation recipient')
    expect(error.cause).toBeUndefined()
    expect(JSON.stringify(error)).not.toContain(to || 'attacker@example.test')
  })

  it.each(['en', 'zh-CN'])(
    'never logs the rendered %s body or usable accept link',
    async (language) => {
      const message = teamInvitationEmail({ ...invitation, language })
      const output: string[] = []
      await createLogMailer((line) => output.push(line)).send(message)
      expect(output).toEqual(['[mail] {"notSent":"SMTP_URL is not set","sensitive":true}'])
      const log = output.join('\n')
      for (const privateValue of [
        invitation.to,
        invitation.teamName,
        invitation.inviterName,
        invitation.invitationId,
        acceptLink,
        message.subject,
        message.text,
        message.html ?? '',
      ]) {
        expect(log).not.toContain(privateValue)
      }
      expect(log).not.toMatch(/https?:\/\/|\/app\/join|invitationId/)
    },
  )
})
