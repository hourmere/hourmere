/** Read only the loopback SMTP sink's text body; never print its one-time links. */
export function smtpTextBody(message: string): string {
  const plain = message.match(
    /Content-Type: text\/plain[^\r\n]*\r\n([\s\S]*?)\r\n\r\n([\s\S]*?)(?:\r\n--|$)/i,
  )
  if (!plain) throw new Error('SMTP mail must contain a plain-text body')
  const [, headers = '', body = ''] = plain
  if (/Content-Transfer-Encoding: base64/i.test(headers))
    return Buffer.from(body.replaceAll(/\s/g, ''), 'base64').toString('utf8')
  if (!/Content-Transfer-Encoding: quoted-printable/i.test(headers)) return body
  return body
    .replaceAll(/=\r\n/g, '')
    .replaceAll(/=([0-9A-F]{2})/gi, (_, byte: string) =>
      String.fromCharCode(Number.parseInt(byte, 16)),
    )
}
