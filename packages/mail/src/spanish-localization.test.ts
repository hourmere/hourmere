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
  inviteeTimeZone: 'Europe/Madrid',
  start: at('2026-10-20T08:00:00Z'),
  end: at('2026-10-20T08:30:00Z'),
  previous: { start: at('2026-10-19T08:00:00Z'), end: at('2026-10-19T08:30:00Z') },
  location: { kind: 'link' as const, url: 'https://meet.google.com/fixture' },
}
const recipients = {
  invitee: {
    role: 'attendee',
    email: meeting.inviteeEmail,
    timeZone: 'Europe/Madrid',
    manageLinks: {
      reschedule: 'https://example.test/booking#token=fixture&action=reschedule',
      cancel: 'https://example.test/booking#token=fixture&action=cancel',
    },
  },
  guest: { role: 'attendee', email: 'guest@example.test', timeZone: 'Europe/Madrid' },
  host: { role: 'host', email: 'grace@example.test', timeZone: 'Europe/Madrid', answers: [] },
} satisfies Record<string, BookingEmailRecipient>
const kinds: BookingEmailKind[] = [
  'confirmed',
  'rescheduled',
  'cancelled',
  'reminder',
  'conference_failed',
]

describe('Spanish mail catalogue', () => {
  for (const kind of kinds) {
    for (const [role, recipient] of Object.entries(recipients)) {
      it(`renders ${kind} subject, text and HTML for the ${role}`, () => {
        const message = bookingEmail(kind, meeting, { ...recipient, locale: 'es' })
        const prefix = {
          confirmed: role === 'host' ? 'Nueva reserva:' : 'Confirmación:',
          rescheduled: 'Reprogramación:',
          cancelled: 'Cancelación:',
          reminder: 'Recordatorio:',
          conference_failed: 'Problema con el enlace de reunión:',
        }[kind]
        expect(message.subject.startsWith(prefix)).toBe(true)
        if (kind === 'rescheduled')
          expect(message.subject).toContain(', nuevo horario: mar, 20 oct')
        expect(message.html).toContain('<html lang="es">')
        expect(message.text).toContain('Evento: Intro {other}')
        expect(message.html).toContain('>Evento</td>')
        for (const content of [message.text, message.html ?? '']) {
          expect(content).toContain('Intro {other}')
          expect(content).toContain('martes, 20 de octubre de 2026')
          expect(content).toContain('10:00 – 10:30')
          expect(content).toContain('Ha recibido este correo electrónico porque')
          expect(content).not.toMatch(/Your meeting|What:|When:|You received this email/)
          if (kind === 'conference_failed') {
            expect(content).toContain(
              'No se ha enviado ninguna invitación de calendario definitiva.',
            )
            if (role === 'host')
              expect(content).toContain('reintentar la conciliación de forma segura')
            expect(content).toContain(
              role === 'host'
                ? 'no se pudo preparar Google Meet'
                : 'el anfitrión debe corregir el enlace de Google Meet',
            )
          } else if (kind !== 'cancelled') {
            expect(content).toContain('Unirse con Google Meet')
          }
        }
        expect(message.text.includes('token=fixture')).toBe(
          role === 'invitee' && kind !== 'cancelled',
        )
      })
    }
  }

  it('maps Spanish regional preferences and retains English for unknown languages', () => {
    const spanish = bookingEmail('confirmed', meeting, { ...recipients.invitee, locale: 'es' })
    for (const locale of ['es-ES', 'es-MX', 'es-419', 'es-AR', 'es-CO', 'es-US']) {
      expect(bookingEmail('confirmed', meeting, { ...recipients.invitee, locale })).toEqual(spanish)
    }
    for (const locale of ['qaa', 'not_a_locale', undefined, null]) {
      expect(bookingEmail('confirmed', meeting, { ...recipients.invitee, locale })).toEqual(
        bookingEmail('confirmed', meeting, { ...recipients.invitee, locale: 'en' }),
      )
    }
  })

  it('preserves literal data and keeps Spanish actions and questions in both alternatives', () => {
    const message = bookingEmail(
      'confirmed',
      {
        ...meeting,
        eventName: '<script>alert("test")</script> {other}',
        hostName: 'Grace\r\nBcc: injected@example.test',
      },
      { ...recipients.invitee, locale: 'es' },
    )
    expect(message.subject).not.toMatch(/[\r\n]/)
    expect(message.text).toContain('<script>alert("test")</script> {other}')
    expect(message.html).toContain('&lt;script&gt;alert(&quot;test&quot;)&lt;/script&gt; {other}')
    expect(message.html).not.toContain('<script>')
    for (const content of [message.text, message.html ?? '']) {
      expect(content).toContain('¿Necesita realizar un cambio?')
      expect(content).toContain('Reprogramar')
      expect(content).toContain('Cancelar')
    }
  })

  it('allows the long host email time-zone label to wrap beside the value', () => {
    const message = bookingEmail('confirmed', meeting, {
      ...recipients.host,
      timeZone: 'America/New_York',
      locale: 'es',
    })
    const labelCell = message.html?.match(/<td style="([^"]*)">Horario del asistente<\/td>/)?.[1]
    expect(labelCell).toContain('white-space: normal;')
    expect(labelCell).toContain('width: 35%;')
    expect(labelCell).toContain('overflow-wrap: anywhere;')
    expect(message.text).toContain('Horario del asistente: mar, 20 oct, 10:00')
  })

  it('formats Spanish dates and 24-hour times through DST and across midnight', () => {
    expect(formatMeetingTime(meeting.start, meeting.end, 'Europe/Madrid', 'es')).toBe(
      'martes, 20 de octubre de 2026, 10:00 – 10:30 (Europe/Madrid, GMT+02:00)',
    )
    expect(
      formatMeetingTime(
        at('2026-10-25T01:30:00Z'),
        at('2026-10-25T02:00:00Z'),
        'Europe/Madrid',
        'es',
      ),
    ).toBe('domingo, 25 de octubre de 2026, 2:30 – 3:00 (Europe/Madrid, GMT+01:00)')
    expect(
      formatMeetingTime(
        at('2026-10-20T21:30:00Z'),
        at('2026-10-20T22:30:00Z'),
        'Europe/Madrid',
        'es',
      ),
    ).toBe(
      'martes, 20 de octubre de 2026, 23:30 – miércoles, 21 de octubre de 2026, 0:30 (Europe/Madrid, GMT+02:00)',
    )
  })

  it.each(['invitee', 'host', 'guest'] as const)(
    'explains the %s calendar response consequences without changing calendar identity',
    (role) => {
      const attachment = icsAttachment({
        method: 'REQUEST',
        uid: 'spanish-fixture@hourmere',
        sequence: 1,
        stamp: at('2026-10-19T08:00:00Z'),
        start: meeting.start,
        end: meeting.end,
        summary: calendarSummary(meeting.eventName, meeting.hostName, 'es'),
        description: `${calendarBookingDescription(meeting.hostName, 'es')}\n${calendarResponseDescription(role, 'es')}`,
        organizer: { name: 'Grace', email: 'grace@example.test' },
        attendees: [{ name: 'Ada', email: meeting.inviteeEmail }],
      })
      const event = new ICAL.Component(ICAL.parse(attachment.content)).getFirstSubcomponent(
        'vevent',
      )
      expect(event?.getFirstPropertyValue('summary')).toBe('Intro {other} con Grace')
      expect(event?.getFirstPropertyValue('description')).toContain(
        'Reserva con Grace realizada a través de Hourmere.',
      )
      expect(event?.getFirstPropertyValue('description')).toContain(
        'Aceptar o rechazar esta invitación de calendario no cancela la reserva.',
      )
      expect(event?.getFirstPropertyValue('uid')).toBe('spanish-fixture@hourmere')
      expect(attachment.content).toContain('DTSTART:20261020T080000Z')
      expect(attachment.content).not.toContain('token=')
      const message = bookingEmail(
        'confirmed',
        meeting,
        { ...recipients[role], locale: 'es' },
        { attachment },
      )
      for (const content of [message.text, message.html ?? '']) {
        expect(content).toContain(
          role === 'host'
            ? 'El rechazo en su calendario no se sincroniza con Hourmere; para cancelar la reserva, utilice Hourmere.'
            : role === 'invitee'
              ? 'Para cancelarla, utilice el enlace «Cancelar» de este correo electrónico.'
              : 'Para cancelarla, contacte con la persona que realizó la reserva o con el anfitrión.',
        )
      }
    },
  )

  it('renders Spanish sign-in messages and generated answers', () => {
    const message = magicLinkEmail({
      to: meeting.inviteeEmail,
      url: 'https://example.test/sign-in#token=fixture',
      expiresInMinutes: 7,
      language: 'es',
    })
    expect(message.subject).toBe('Inicio de sesión en Hourmere')
    expect(message.html).toContain('<html lang="es">')
    for (const content of [message.text, message.html ?? '']) {
      expect(content).toContain('El enlace caduca en 7 min y')
      expect(content).toContain('solo se puede utilizar una vez')
      expect(content).toContain('el botón de inicio de sesión en la página que se abra')
    }
    expect(bookingHostName('es')).toBe('Anfitrión')
    expect(bookingAnswerText(true, 'es')).toBe('Sí')
    expect(bookingAnswerText(false, 'es')).toBe('No')
    expect(bookingAnswerText(['Literal {other}', 'Respuesta'], 'es')).toBe(
      'Literal {other}, Respuesta',
    )
  })

  it('keeps a one-minute sign-in expiry grammatical in both email alternatives', () => {
    const message = magicLinkEmail({
      to: meeting.inviteeEmail,
      url: 'https://example.test/sign-in#token=fixture',
      expiresInMinutes: 1,
      language: 'es',
    })
    for (const content of [message.text, message.html ?? '']) {
      expect(content).toContain('El enlace caduca en 1 min y solo se puede utilizar una vez.')
      expect(content).toContain('Si no ha solicitado iniciar sesión')
    }
  })

  it('renders the exact invitation identity, explicit acceptance and UTC expiry in Spanish', () => {
    const options = {
      to: meeting.inviteeEmail,
      publicUrl: 'https://example.test',
      invitationId: '019a278e-3ff2-7a91-8fe0-1846a52d0b22',
      teamName: 'Equipo {inviter} & <diseño>',
      inviterName: 'Grace',
      expiresAt: '2026-10-29T17:30:00Z',
      language: 'es',
    }
    const message = teamInvitationEmail(options)
    expect(message.subject).toBe('Invitación para unirse a Equipo {inviter} & <diseño>')
    expect(message.sensitive).toBe(true)
    expect(message.html).toContain('<html lang="es">')
    expect(message.text).toContain('Equipo {inviter} & <diseño>')
    expect(message.html).toContain('Equipo {inviter} &amp; &lt;diseño&gt;')
    for (const content of [message.text, message.html ?? '']) {
      expect(content).toContain(
        'Inicie sesión con ada@example.test, la dirección de correo electrónico que recibió la invitación, y verifíquela',
      )
      expect(content).toContain(
        'Los alias de correo electrónico no pueden sustituir esta dirección.',
      )
      expect(content).toContain(
        'Iniciar sesión no le incorpora al equipo; debe aceptar expresamente la invitación en la página.',
      )
      expect(content).toContain('Esta invitación caduca el 2026-10-29 17:30:00 UTC.')
      expect(content).toContain('Ver y aceptar invitación')
      expect(content).toContain(
        'https://example.test/app/join?invitationId=019a278e-3ff2-7a91-8fe0-1846a52d0b22',
      )
      expect(content).toContain('puede ignorar este correo electrónico.')
    }
    for (const language of ['es-ES', 'es-MX', 'es-419', 'es-AR', 'es-CO', 'es-US'])
      expect(teamInvitationEmail({ ...options, language })).toEqual(message)
    expect(teamInvitationEmail({ ...options, language: 'qaa', defaultLanguage: 'es-MX' })).toEqual(
      message,
    )
    expect(teamInvitationEmail({ ...options, language: 'qaa' })).toEqual(
      teamInvitationEmail({ ...options, language: 'en' }),
    )
  })
})
