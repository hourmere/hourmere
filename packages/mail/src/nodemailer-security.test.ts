import nodemailer from 'nodemailer'
import addressparser from 'nodemailer/lib/addressparser'
import { describe, expect, it } from 'vitest'

const recipient = 'recipient@recipient.example'

// These address-parser boundaries motivated the exact 10.1.4 security pin. Exercise both
// the public parser and the envelope Nodemailer actually builds, without opening a socket.
describe('Nodemailer recipient parsing security', () => {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true })

  it.each([
    {
      name: 'a quoted angle-addr containing a closer and another domain',
      input: '<"a@attacker.example>"@recipient.example>',
      parsed: ['"a@attacker.example>"@recipient.example'],
      envelope: ['"a@attacker.example "@recipient.example'],
    },
    {
      name: 'a group with a semicolon in a quoted display name',
      input: `Group: "name; attacker@attacker.example" <${recipient}>;`,
      parsed: [recipient],
      envelope: [recipient],
    },
    {
      name: 'a group with a semicolon in a comment',
      input: `Group: ${recipient} (name; attacker@attacker.example);`,
      parsed: [recipient],
      envelope: [recipient],
    },
    {
      name: 'a nested comment containing another mailbox',
      input: `(outer (inner) attacker@attacker.example) ${recipient}`,
      parsed: [recipient],
      envelope: [recipient],
    },
    {
      name: 'a bare comment containing a mailbox',
      input: '(attacker@attacker.example)',
      parsed: [],
      envelope: [],
    },
    {
      name: 'an angle-addr containing only a comment',
      input: '<(attacker@attacker.example)>',
      parsed: [],
      envelope: [],
    },
    {
      name: 'a comment separating two addr-specs',
      input: `${recipient} (note) attacker@attacker.example`,
      parsed: [recipient],
      envelope: [recipient],
    },
    {
      name: 'a comment separating an angle-addr from trailing domain text',
      input: `<${recipient}(note)attacker.example>`,
      parsed: [recipient],
      envelope: [recipient],
    },
    {
      name: 'a comment following a quoted local part',
      input: '"recipient"@recipient.example(note)attacker.example',
      parsed: [recipient],
      envelope: [recipient],
    },
  ])('preserves recipient boundaries for $name', async ({ input, parsed, envelope }) => {
    expect(
      addressparser(input, { flatten: true })
        .map(({ address }) => address)
        .filter(Boolean),
    ).toEqual(parsed)
    const message = await transport.sendMail({
      from: 'sender@example.com',
      to: input,
      subject: 'Parser regression fixture',
      text: 'Fixture',
    })
    expect(message.envelope).toEqual({ from: 'sender@example.com', to: envelope })
  })
})
