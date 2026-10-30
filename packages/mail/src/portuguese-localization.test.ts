import ICAL from 'ical.js'
import { describe, expect, it } from 'vitest'
import {
  type BookingEmailKind,
  type BookingEmailRecipient,
  bookingAnswerText,
  bookingEmail,
  bookingHostName,
  formatMeetingTime,
} from './booking.ts'
import {
  calendarBookingDescription,
  calendarResponseDescription,
  calendarSummary,
  icsAttachment,
} from './ics.ts'
import { magicLinkEmail, teamInvitationEmail } from './index.ts'

const at = (value: string) => Temporal.Instant.from(value)
const meeting = {
  eventName: 'Intro {other}',
  hostName: 'Grace',
  inviteeName: 'Ada',
  inviteeEmail: 'ada@example.test',
  inviteeTimeZone: 'America/Sao_Paulo',
  start: at('2026-10-20T13:00:00Z'),
  end: at('2026-10-20T13:30:00Z'),
  previous: { start: at('2026-10-19T13:00:00Z'), end: at('2026-10-19T13:30:00Z') },
  location: { kind: 'link' as const, url: 'https://meet.google.com/fixture' },
}
const recipients = {
  invitee: {
    role: 'attendee',
    email: meeting.inviteeEmail,
    timeZone: 'America/Sao_Paulo',
    manageLinks: {
      reschedule: 'https://example.test/booking#token=fixture&action=reschedule',
      cancel: 'https://example.test/booking#token=fixture&action=cancel',
    },
  },
  guest: { role: 'attendee', email: 'guest@example.test', timeZone: 'America/Sao_Paulo' },
  host: { role: 'host', email: 'grace@example.test', timeZone: 'America/Sao_Paulo', answers: [] },
} satisfies Record<string, BookingEmailRecipient>
const kinds: BookingEmailKind[] = [
  'confirmed',
  'rescheduled',
  'cancelled',
  'reminder',
  'conference_failed',
]

describe('Brazilian Portuguese mail catalogue', () => {
  for (const kind of kinds) {
    for (const [role, recipient] of Object.entries(recipients)) {
      it(`renders ${kind} subject, text and HTML for the ${role}`, () => {
        const message = bookingEmail(kind, meeting, { ...recipient, locale: 'pt-BR' })
        const prefix = {
          confirmed: role === 'host' ? 'Novo agendamento:' : 'Confirmado:',
          rescheduled: 'Reagendado:',
          cancelled: 'Cancelado:',
          reminder: 'Lembrete:',
          conference_failed: 'Link da reunião precisa de atenção:',
        }[kind]
        const description =
          kind === 'conference_failed'
            ? meeting.eventName
            : `${meeting.eventName} com ${role === 'host' ? meeting.inviteeName : meeting.hostName}`
        const when = 'ter., 20 de out., 10:00 (America/Sao Paulo, GMT-03:00)'
        expect(message.subject).toBe(
          `${prefix} ${description}${kind === 'rescheduled' ? ', agora: ' : ' — '}${when}`,
        )
        expect(message.html).toContain('<html lang="pt-BR">')
        expect(message.text).toContain('O quê: Intro {other}')
        expect(message.html).toContain('>O quê</td>')
        for (const content of [message.text, message.html ?? '']) {
          expect(content).toContain('Intro {other}')
          expect(content).toContain('terça-feira, 20 de outubro de 2026')
          expect(content).toContain('10:00 – 10:30')
          expect(content).toContain('Você recebeu este e-mail porque')
          expect(content).not.toMatch(/Your meeting|What:|When:|You received this email/)
          if (kind === 'conference_failed') {
            expect(content).toContain('Nenhum convite definitivo da agenda foi enviado.')
            if (role === 'host')
              expect(content).toContain('tentar novamente uma reconciliação segura')
            expect(content).toContain(
              role === 'host'
                ? 'não foi possível preparar o Google Meet'
                : 'o anfitrião precisa corrigir o link do Google Meet',
            )
          } else if (kind !== 'cancelled') {
            expect(content).toContain('Participar com o Google Meet')
          }
        }
        expect(message.text.includes('token=fixture')).toBe(
          role === 'invitee' && kind !== 'cancelled',
        )
      })
    }
  }

  it('maps bare and Brazilian Portuguese while skipping European Portuguese and unknown languages', () => {
    const portuguese = bookingEmail('confirmed', meeting, {
      ...recipients.invitee,
      locale: 'pt-BR',
    })
    for (const locale of ['pt', 'PT-br', 'pt-Latn', 'pt-Latn-BR', 'pt-AO']) {
      expect(bookingEmail('confirmed', meeting, { ...recipients.invitee, locale })).toEqual(
        portuguese,
      )
    }
    for (const locale of ['pt-PT', 'pt-Latn-PT', 'qaa', 'not_a_locale', undefined, null]) {
      expect(bookingEmail('confirmed', meeting, { ...recipients.invitee, locale })).toEqual(
        bookingEmail('confirmed', meeting, { ...recipients.invitee, locale: 'en' }),
      )
    }
  })

  it('preserves literal data and escapes HTML while keeping Portuguese actions in both alternatives', () => {
    const message = bookingEmail(
      'confirmed',
      {
        ...meeting,
        eventName: '<script>alert("test")</script> {other}',
        hostName: 'Grace\r\nBcc: injected@example.test',
      },
      { ...recipients.invitee, locale: 'pt-BR' },
    )
    expect(message.subject).not.toMatch(/[\r\n]/)
    expect(message.text).toContain('<script>alert("test")</script> {other}')
    expect(message.html).toContain('&lt;script&gt;alert(&quot;test&quot;)&lt;/script&gt; {other}')
    expect(message.html).not.toContain('<script>')
    for (const content of [message.text, message.html ?? '']) {
      expect(content).toContain('Precisa fazer uma alteração?')
      expect(content).toContain('Reagendar')
      expect(content).toContain('Cancelar')
    }
  })

  it('allows the host email time-zone label to wrap beside a different recipient zone', () => {
    const message = bookingEmail('confirmed', meeting, {
      ...recipients.host,
      timeZone: 'America/New_York',
      locale: 'pt-BR',
    })
    const labelCell = message.html?.match(/<td style="([^"]*)">Horário do participante<\/td>/)?.[1]
    expect(labelCell).toContain('white-space: normal;')
    expect(labelCell).toContain('width: 35%;')
    expect(labelCell).toContain('overflow-wrap: anywhere;')
    expect(message.text).toContain('Horário do participante: ter., 20 de out., 10:00')
  })

  it('formats Brazilian dates and 24-hour times in Brazil, through DST and across midnight', () => {
    expect(formatMeetingTime(meeting.start, meeting.end, 'America/Sao_Paulo', 'pt-BR')).toBe(
      'terça-feira, 20 de outubro de 2026, 10:00 – 10:30 (America/Sao Paulo, GMT-03:00)',
    )
    expect(
      formatMeetingTime(
        at('2026-11-01T06:30:00Z'),
        at('2026-11-01T07:00:00Z'),
        'America/New_York',
        'pt-BR',
      ),
    ).toBe('domingo, 1 de novembro de 2026, 1:30 – 2:00 (America/New York, GMT-05:00)')
    expect(
      formatMeetingTime(
        at('2026-10-21T02:30:00Z'),
        at('2026-10-21T03:30:00Z'),
        'America/Sao_Paulo',
        'pt-BR',
      ),
    ).toBe(
      'terça-feira, 20 de outubro de 2026, 23:30 – quarta-feira, 21 de outubro de 2026, 0:30 (America/Sao Paulo, GMT-03:00)',
    )
    const moved = bookingEmail(
      'rescheduled',
      {
        ...meeting,
        previous: { start: at('2026-11-01T05:30:00Z'), end: at('2026-11-01T05:45:00Z') },
        start: at('2026-11-01T06:30:00Z'),
        end: at('2026-11-01T06:45:00Z'),
      },
      { ...recipients.invitee, timeZone: 'America/New_York', locale: 'pt-BR' },
    )
    expect(moved.text).toContain('GMT-04:00')
    expect(moved.text).toContain('GMT-05:00')
    expect(moved.text).toContain('Horário anterior:')
  })

  it.each(['invitee', 'host', 'guest'] as const)(
    'explains the %s calendar response consequences without changing calendar identity',
    (role) => {
      const attachment = icsAttachment({
        method: 'REQUEST',
        uid: 'portuguese-fixture@hourmere',
        sequence: 1,
        stamp: at('2026-10-19T08:00:00Z'),
        start: meeting.start,
        end: meeting.end,
        summary: calendarSummary(meeting.eventName, meeting.hostName, 'pt-BR'),
        description: `${calendarBookingDescription(meeting.hostName, 'pt-BR')}\n${calendarResponseDescription(role, 'pt-BR')}`,
        organizer: { name: 'Grace', email: 'grace@example.test' },
        attendees: [{ name: 'Ada', email: meeting.inviteeEmail }],
      })
      const event = new ICAL.Component(ICAL.parse(attachment.content)).getFirstSubcomponent(
        'vevent',
      )
      expect(event?.getFirstPropertyValue('summary')).toBe('Intro {other} com Grace')
      expect(event?.getFirstPropertyValue('description')).toContain(
        'Agendado com Grace pelo Hourmere.',
      )
      expect(event?.getFirstPropertyValue('description')).toContain(
        'Aceitar ou recusar este convite da agenda não cancela o agendamento.',
      )
      expect(event?.getFirstPropertyValue('uid')).toBe('portuguese-fixture@hourmere')
      expect(attachment.content).toContain('DTSTART:20261020T130000Z')
      expect(attachment.content).not.toContain('token=')
      const message = bookingEmail(
        'confirmed',
        meeting,
        { ...recipients[role], locale: 'pt-BR' },
        { attachment },
      )
      for (const content of [message.text, message.html ?? '']) {
        expect(content).toContain(
          role === 'host'
            ? 'A recusa na sua agenda não é sincronizada com o Hourmere; para cancelar o agendamento, use o Hourmere.'
            : role === 'invitee'
              ? 'Para cancelar, use o link “Cancelar” neste e-mail.'
              : 'Para cancelar, entre em contato com quem fez o agendamento ou com o anfitrião.',
        )
      }
    },
  )

  it.each([0, 1, 7])(
    'renders direct Portuguese sign-in messages with %i minutes remaining',
    (minutes) => {
      const message = magicLinkEmail({
        to: meeting.inviteeEmail,
        url: 'https://example.test/sign-in#token=fixture',
        expiresInMinutes: minutes,
        language: 'pt-BR',
      })
      expect(message.subject).toBe('Entrar no Hourmere')
      expect(message.html).toContain('<html lang="pt-BR">')
      for (const content of [message.text, message.html ?? '']) {
        expect(content).toContain(`O link expira em ${minutes} min e só pode ser usado uma vez.`)
        expect(content).toContain('Se você não solicitou a entrada, pode ignorar este e-mail.')
        expect(content).toContain('o botão de entrada na página que abrir')
      }
      expect(bookingHostName('pt-BR')).toBe('Anfitrião')
      expect(bookingAnswerText(true, 'pt-BR')).toBe('Sim')
      expect(bookingAnswerText(false, 'pt-BR')).toBe('Não')
      expect(bookingAnswerText(['Literal {other}', 'Resposta'], 'pt-BR')).toBe(
        'Literal {other}, Resposta',
      )
    },
  )

  it('renders the exact invitation identity, explicit acceptance and UTC expiry in Portuguese', () => {
    const options = {
      to: meeting.inviteeEmail,
      publicUrl: 'https://example.test',
      invitationId: '019a278e-3ff2-7a91-8fe0-1846a52d0b22',
      teamName: 'Equipe {inviter} & <design>',
      inviterName: 'Grace',
      expiresAt: '2026-10-29T17:30:00Z',
      language: 'pt-BR',
    }
    const message = teamInvitationEmail(options)
    expect(message.subject).toBe('Convite para participar de Equipe {inviter} & <design>')
    expect(message.sensitive).toBe(true)
    expect(message.html).toContain('<html lang="pt-BR">')
    expect(message.text).toContain('Equipe {inviter} & <design>')
    expect(message.html).toContain('Equipe {inviter} &amp; &lt;design&gt;')
    for (const content of [message.text, message.html ?? '']) {
      expect(content).toContain(
        'Entre com ada@example.test, o endereço de e-mail que recebeu o convite, e confirme esse endereço.',
      )
      expect(content).toContain('Aliases de e-mail não podem substituir esse endereço.')
      expect(content).toContain(
        'Entrar na conta não faz você participar da equipe; você precisa aceitar o convite explicitamente na página.',
      )
      expect(content).toContain('Este convite expira em 2026-10-29 17:30:00 UTC.')
      expect(content).toContain('Ver e aceitar convite')
      expect(content).toContain(
        'https://example.test/app/join?invitationId=019a278e-3ff2-7a91-8fe0-1846a52d0b22',
      )
      expect(content).toContain('pode ignorar este e-mail.')
    }
    for (const language of ['pt', 'PT-br', 'pt-Latn-BR', 'pt-AO'])
      expect(teamInvitationEmail({ ...options, language })).toEqual(message)
    expect(teamInvitationEmail({ ...options, language: 'qaa', defaultLanguage: 'pt-BR' })).toEqual(
      message,
    )
    for (const language of ['qaa', 'pt-PT'])
      expect(teamInvitationEmail({ ...options, language })).toEqual(
        teamInvitationEmail({ ...options, language: 'en' }),
      )
  })
})
