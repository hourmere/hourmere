import { generateKeyPairSync, sign } from 'node:crypto'

function der(tag: number, ...parts: Buffer[]) {
  const body = Buffer.concat(parts)
  const length =
    body.length < 128
      ? Buffer.from([body.length])
      : body.length < 256
        ? Buffer.from([0x81, body.length])
        : Buffer.from([0x82, body.length >> 8, body.length & 0xff])
  return Buffer.concat([Buffer.from([tag]), length, body])
}

/** Generates a self-signed certificate and key for an in-process SAML IdP fixture. */
export function samlSigningIdentity(commonName: string, modulusLength = 2048) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength })
  const algorithm = der(0x30, Buffer.from('06092a864886f70d01010b0500', 'hex'))
  const name = der(
    0x30,
    der(0x31, der(0x30, Buffer.from('0603550403', 'hex'), der(0x0c, Buffer.from(commonName)))),
  )
  const validity = der(
    0x30,
    der(0x17, Buffer.from('250101000000Z')),
    der(0x17, Buffer.from('450101000000Z')),
  )
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    algorithm,
    name,
    validity,
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  )
  const signature = sign('sha256', tbs, privateKey)
  const certificate = der(0x30, tbs, algorithm, der(0x03, Buffer.from([0]), signature))
  const base64 = certificate.toString('base64')
  const pem = `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)?.join('\n')}\n-----END CERTIFICATE-----\n`
  return { privateKey, pem, base64 }
}
