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
import { mailCatalogues } from './catalogue.ts'
import {
  calendarBookingDescription,
  calendarResponseDescription,
  calendarSummary,
  icsAttachment,
} from './ics.ts'
import { magicLinkEmail } from './index.ts'

const at = (value: string) => Temporal.Instant.from(value)
const meeting = {
  eventName: 'Intro {other}',
  hostName: 'Grace',
  inviteeName: 'Ada',
  inviteeEmail: 'ada@example.test',
  inviteeTimeZone: 'Europe/Paris',
  start: at('2026-10-20T08:00:00Z'),
  end: at('2026-10-20T08:30:00Z'),
  previous: { start: at('2026-10-19T08:00:00Z'), end: at('2026-10-19T08:30:00Z') },
  location: { kind: 'link' as const, url: 'https://meet.google.com/fixture' },
}
const recipients = {
  invitee: {
    role: 'attendee',
    email: meeting.inviteeEmail,
    timeZone: 'Europe/Paris',
    manageLinks: {
      reschedule: 'https://example.test/booking#token=fixture&action=reschedule',
      cancel: 'https://example.test/booking#token=fixture&action=cancel',
    },
  },
  guest: { role: 'attendee', email: 'guest@example.test', timeZone: 'Europe/Paris' },
  host: { role: 'host', email: 'grace@example.test', timeZone: 'Europe/Paris', answers: [] },
} satisfies Record<string, BookingEmailRecipient>
const kinds: BookingEmailKind[] = [
  'confirmed',
  'rescheduled',
  'cancelled',
  'reminder',
  'conference_failed',
]

describe('French mail catalogue', () => {
  for (const kind of kinds) {
    for (const [role, recipient] of Object.entries(recipients)) {
      it(`renders ${kind} subject, text and HTML for the ${role}`, () => {
        const message = bookingEmail(kind, meeting, { ...recipient, locale: 'fr' })
        const prefix = {
          confirmed: role === 'host' ? 'Nouvelle réservation\u00a0:' : 'Confirmation\u00a0:',
          rescheduled: 'Replanification\u00a0:',
          cancelled: 'Annulation\u00a0:',
          reminder: 'Rappel\u00a0:',
          conference_failed: 'Problème avec le lien de réunion\u00a0:',
        }[kind]
        expect(message.subject.startsWith(prefix)).toBe(true)
        if (kind === 'rescheduled')
          expect(message.subject).toContain(', nouvel horaire le mar. 20 oct.')
        expect(message.html).toContain('<html lang="fr">')
        expect(message.text).toContain('Événement\u00a0: Intro {other}')
        expect(message.html).toContain('>Événement</td>')
        for (const content of [message.text, message.html ?? '']) {
          expect(content).toContain('Intro {other}')
          expect(content).toContain('mardi 20 octobre 2026')
          expect(content).toContain('10:00 – 10:30')
          expect(content).toContain('Vous recevez cet e-mail parce que')
          expect(content).not.toMatch(/Your meeting|What:|When:|You received this email/)
          if (kind === 'conference_failed') {
            expect(content).toContain('Aucune invitation de calendrier définitive n’a été envoyée.')
            if (role === 'host')
              expect(content).toContain('relancer la réconciliation en toute sécurité')
            expect(content).toContain(
              role === 'host'
                ? 'Google Meet n’a pas pu être préparé'
                : 'l’hôte doit corriger le lien Google Meet',
            )
          } else if (kind !== 'cancelled') {
            expect(content).toContain('Participer avec Google Meet')
          }
        }
        expect(message.text.includes('token=fixture')).toBe(
          role === 'invitee' && kind !== 'cancelled',
        )
      })
    }
  }

  it('maps French regional preferences and retains English for unknown languages', () => {
    const french = bookingEmail('confirmed', meeting, { ...recipients.invitee, locale: 'fr' })
    for (const locale of ['fr-FR', 'fr-CA', 'fr-BE', 'fr-CH']) {
      expect(bookingEmail('confirmed', meeting, { ...recipients.invitee, locale })).toEqual(french)
    }
    for (const locale of ['qaa', 'not_a_locale', undefined, null]) {
      expect(bookingEmail('confirmed', meeting, { ...recipients.invitee, locale })).toEqual(
        bookingEmail('confirmed', meeting, { ...recipients.invitee, locale: 'en' }),
      )
    }
  })

  it('keeps French non-breaking punctuation in catalogues, headers, text and HTML', () => {
    for (const translation of Object.values(mailCatalogues.fr ?? {})) {
      expect(translation).not.toMatch(/[^\u00a0\u202f][:;?!]/u)
      expect(translation).not.toMatch(/«[^\u00a0\u202f]|[^\u00a0\u202f]»/u)
    }
    const message = bookingEmail('confirmed', meeting, { ...recipients.invitee, locale: 'fr' })
    expect(message.subject).toContain('Confirmation\u00a0:')
    for (const content of [message.text, message.html ?? '']) {
      expect(content).toContain('Vous souhaitez modifier la réservation\u00a0?')
      expect(content).toContain('Replanifier\u00a0:')
    }
    expect(message.html).toContain('votre navigateur\u00a0:')
  })

  it('allows the long host email time-zone label to wrap beside the value', () => {
    const message = bookingEmail('confirmed', meeting, {
      ...recipients.host,
      timeZone: 'America/New_York',
      locale: 'fr',
    })
    const labelCell = message.html?.match(/<td style="([^"]*)">Horaire du participant<\/td>/)?.[1]
    expect(labelCell).toContain('white-space: normal;')
    expect(labelCell).toContain('width: 35%;')
    expect(labelCell).toContain('overflow-wrap: anywhere;')
    expect(message.text).toContain('Horaire du participant\u00a0: mar. 20 oct., 10:00')
  })

  it('formats French dates and 24-hour times through DST and across midnight', () => {
    expect(formatMeetingTime(meeting.start, meeting.end, 'Europe/Paris', 'fr')).toBe(
      'mardi 20 octobre 2026, 10:00 – 10:30 (Europe/Paris, GMT+02:00)',
    )
    expect(
      formatMeetingTime(
        at('2026-10-25T01:30:00Z'),
        at('2026-10-25T02:00:00Z'),
        'Europe/Paris',
        'fr',
      ),
    ).toBe('dimanche 25 octobre 2026, 2:30 – 3:00 (Europe/Paris, GMT+01:00)')
    expect(
      formatMeetingTime(
        at('2026-10-20T21:30:00Z'),
        at('2026-10-20T22:30:00Z'),
        'Europe/Paris',
        'fr',
      ),
    ).toBe(
      'mardi 20 octobre 2026, 23:30 – mercredi 21 octobre 2026, 0:30 (Europe/Paris, GMT+02:00)',
    )
  })

  it.each(['invitee', 'host', 'guest'] as const)(
    'explains the %s calendar response consequences without changing calendar identity',
    (role) => {
      const attachment = icsAttachment({
        method: 'REQUEST',
        uid: 'french-fixture@hourmere',
        sequence: 1,
        stamp: at('2026-10-19T08:00:00Z'),
        start: meeting.start,
        end: meeting.end,
        summary: calendarSummary(meeting.eventName, meeting.hostName, 'fr'),
        description: `${calendarBookingDescription(meeting.hostName, 'fr')}\n${calendarResponseDescription(role, 'fr')}`,
        organizer: { name: 'Grace', email: 'grace@example.test' },
        attendees: [{ name: 'Ada', email: meeting.inviteeEmail }],
      })
      const event = new ICAL.Component(ICAL.parse(attachment.content)).getFirstSubcomponent(
        'vevent',
      )
      expect(event?.getFirstPropertyValue('summary')).toBe('Intro {other} avec Grace')
      expect(event?.getFirstPropertyValue('description')).toContain(
        'Réservé avec Grace via Hourmere.',
      )
      expect(event?.getFirstPropertyValue('description')).toContain(
        'Accepter ou refuser cette invitation de calendrier n’annule pas la réservation.',
      )
      expect(event?.getFirstPropertyValue('uid')).toBe('french-fixture@hourmere')
      expect(attachment.content).toContain('DTSTART:20261020T080000Z')
      expect(attachment.content).not.toContain('token=')
      const message = bookingEmail(
        'confirmed',
        meeting,
        { ...recipients[role], locale: 'fr' },
        { attachment },
      )
      for (const content of [message.text, message.html ?? '']) {
        expect(content).toContain(
          role === 'host'
            ? 'Un refus dans votre calendrier n’est pas synchronisé avec Hourmere\u00a0; pour annuler la réservation, utilisez Hourmere.'
            : role === 'invitee'
              ? 'Pour l’annuler, utilisez le lien «\u00a0Annuler la réservation\u00a0» dans cet e-mail.'
              : 'Pour l’annuler, contactez la personne qui a réservé ou l’hôte.',
        )
      }
    },
  )

  it('renders French sign-in messages and generated answers', () => {
    const message = magicLinkEmail({
      to: meeting.inviteeEmail,
      url: 'https://example.test/sign-in#token=fixture',
      expiresInMinutes: 7,
      language: 'fr',
    })
    expect(message.subject).toBe('Se connecter à Hourmere')
    expect(message.html).toContain('<html lang="fr">')
    for (const content of [message.text, message.html ?? '']) {
      expect(content).toContain('Ce lien expire dans 7 min et')
      expect(content).toContain('ne fonctionne qu’une seule fois')
      expect(content).toContain('le bouton de connexion sur la page qui s’ouvre')
    }
    expect(bookingHostName('fr')).toBe('Hôte')
    expect(bookingAnswerText(true, 'fr')).toBe('Oui')
    expect(bookingAnswerText(false, 'fr')).toBe('Non')
    expect(bookingAnswerText(['Literal {other}', 'Réponse'], 'fr')).toBe('Literal {other}, Réponse')
  })

  it('keeps a one-minute sign-in expiry grammatical in both email alternatives', () => {
    const message = magicLinkEmail({
      to: meeting.inviteeEmail,
      url: 'https://example.test/sign-in#token=fixture',
      expiresInMinutes: 1,
      language: 'fr',
    })
    for (const content of [message.text, message.html ?? '']) {
      expect(content).toContain('Ce lien expire dans 1 min et ne fonctionne qu’une seule fois.')
      expect(content).toContain('Si vous n’avez pas demandé à vous connecter')
    }
  })
})
