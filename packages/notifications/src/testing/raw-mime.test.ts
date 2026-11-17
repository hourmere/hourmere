import { describe, expect, it } from 'vitest'
import { decodeMime } from './raw-mime.ts'

// The shape nodemailer writes for a booking email with an iMIP calendar alternative.
const message = (htmlLines: string[]) =>
  [
    'To: invitee@people.example.test',
    'Content-Type: multipart/mixed; boundary="--_NmP-0001-Part_1"',
    '',
    '----_NmP-0001-Part_1',
    'Content-Type: multipart/alternative;',
    ' boundary="--_NmP-0001-Part_2"',
    '',
    '----_NmP-0001-Part_2',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Booked.',
    '',
    '----_NmP-0001-Part_2',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    ...htmlLines,
    '',
    '----_NmP-0001-Part_2',
    'Content-Type: text/calendar; charset=utf-8; method=REQUEST',
    'Content-Transfer-Encoding: 7bit',
    '',
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:seat@hourmere',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
    '----_NmP-0001-Part_2--',
    '',
    '----_NmP-0001-Part_1',
    'Content-Type: application/ics; name=invite.ics',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n').toString('base64'),
    '----_NmP-0001-Part_1--',
  ].join('\r\n')

describe('decodeMime', () => {
  it('finds the calendar part', () => {
    const decoded = decodeMime(
      message(['<p><a href=3D"https://x.example.test/#token=3Dab=', 'cd">Cancel</a></p>']),
    )
    expect(decoded.ics).toContain('UID:seat@hourmere')
    expect(decoded.decoded).toContain('#token=abcd')
  })

  it('finds it when a soft line break puts "--" from a token at the start of an HTML line', () => {
    // Base64url tokens contain "-"; a quoted-printable soft break can land right before "--".
    const decoded = decodeMime(
      message(['<p><a href=3D"https://x.example.test/#token=3Dab=', '--cd">Cancel</a></p>']),
    )
    expect(decoded.ics).toContain('UID:seat@hourmere')
    expect(decoded.decoded).toContain('#token=ab--cd')
  })
})
