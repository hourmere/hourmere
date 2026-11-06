import { randomBytes } from 'node:crypto'
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createCalDavCredentialRecord, readCalDavCredentials } from './caldav-credentials.ts'
import { decryptCredential, encryptCredential } from './credentials.ts'

const input = {
  serverUrl: 'https://DAV.example.test:443/remote.php/dav',
  username: 'synthetic-user@example.test',
  password: 'synthetic-app-password',
}
const canonical = { ...input, serverUrl: 'https://dav.example.test/remote.php/dav' }
const key = randomBytes(32)

function rejectsSafely(action: () => unknown, operation = 'decrypted') {
  let failure: unknown
  try {
    action()
  } catch (error) {
    failure = error
  }
  expect(failure instanceof Error).toBe(true)
  const error = failure as Error
  expect(error.message).toBe(`CalDAV credentials could not be ${operation}`)
  expect(error.cause).toBeUndefined()
  expect(JSON.stringify(error).includes(input.password)).toBe(false)
}

describe('CalDAV credential records', () => {
  it('encrypts URL, username and app password into the existing connection shape', () => {
    const record = createCalDavCredentialRecord(key, 'owner', input)
    expect(record.provider).toBe('caldav')
    expect(record.account_email).toBeNull()
    expect(record.scopes).toEqual([])
    for (const value of Object.values(input)) {
      expect(record.credentials.includes(Buffer.from(value))).toBe(false)
      expect(JSON.stringify(record).includes(value)).toBe(false)
    }
    expect(readCalDavCredentials(key, record)).toEqual(canonical)
    const again = createCalDavCredentialRecord(key, 'owner', canonical)
    expect(again.external_account_id).toBe(record.external_account_id)
    expect(again.credentials.equals(record.credentials)).toBe(false)
    expect(again.id === record.id).toBe(false)
  })

  it.each([
    (value: unknown) => JSON.stringify(value),
    (value: unknown) => inspect(value),
    (value: unknown) => String(value),
  ])('redacts decrypted passwords in %s', (render) => {
    const record = createCalDavCredentialRecord(key, 'owner', input)
    const credentials = readCalDavCredentials(key, record)
    const output = render(credentials)
    expect(output).toContain('[REDACTED]')
    expect(output).not.toContain(input.password)
    expect(credentials.password).toBe(input.password)
  })

  it('uses the documented unambiguous provider, owner, row and account binding', () => {
    const record = createCalDavCredentialRecord(key, 'owner', input)
    const aad = JSON.stringify(['caldav', 1, record.user_id, record.id, record.external_account_id])
    let authenticated = false
    try {
      authenticated = JSON.parse(decryptCredential(key, aad, record.credentials)).version === 1
    } catch {}
    expect(authenticated).toBe(true)
  })

  it.each(['user_id', 'id', 'external_account_id', 'provider'] as const)(
    'rejects ciphertext moved across %s',
    (field) => {
      const record = createCalDavCredentialRecord(key, 'owner', input)
      rejectsSafely(() => readCalDavCredentials(key, { ...record, [field]: 'other' }))
    },
  )

  it('rejects tampering, truncation, unknown envelope version and a different key', () => {
    const record = createCalDavCredentialRecord(key, 'owner', input)
    const damaged = Buffer.from(record.credentials)
    damaged[damaged.length - 1] = (damaged.at(-1) ?? 0) ^ 1
    const version = Buffer.from(record.credentials)
    version[0] = 2
    for (const credentials of [damaged, version, record.credentials.subarray(0, 20)]) {
      rejectsSafely(() => readCalDavCredentials(key, { ...record, credentials }))
    }
    rejectsSafely(() => readCalDavCredentials(randomBytes(32), record))
  })

  it.each([
    { password: '' },
    { password: '\ud800' },
    { username: 'bad\u0085value' },
    { serverUrl: ' https://dav.example.test/' },
    { serverUrl: 'https://dav.example.test/\\other' },
    { password: 'bad\r\nheader' },
    { username: 'user:password' },
    { serverUrl: 'http://dav.example.test/' },
    { serverUrl: 'https://user:password@dav.example.test/' },
    { serverUrl: 'https://dav.example.test/#password' },
    { serverUrl: 'https://dav.example.test/?password=value' },
    { serverUrl: 'not a URL' },
  ])('rejects invalid input without reflecting it', (change) => {
    rejectsSafely(
      () => createCalDavCredentialRecord(key, 'owner', { ...input, ...change }),
      'encrypted',
    )
  })

  it('rejects malformed or mismatched authenticated plaintext without leaking it', () => {
    const record = createCalDavCredentialRecord(key, 'owner', input)
    const aad = JSON.stringify(['caldav', 1, record.user_id, record.id, record.external_account_id])
    for (const value of [
      'invalid JSON',
      JSON.stringify({ ...canonical, version: 2 }),
      JSON.stringify({ ...canonical, version: 1, password: '' }),
      JSON.stringify({ ...canonical, version: 1, username: 'different-user' }),
      JSON.stringify({ ...canonical, version: 1, serverUrl: input.serverUrl }),
    ]) {
      const credentials = encryptCredential(key, aad, value)
      rejectsSafely(() => readCalDavCredentials(key, { ...record, credentials }))
    }
  })
})
