import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

const base = { DATABASE_URL: 'postgres://unused/unused', BETTER_AUTH_SECRET: 'a'.repeat(32) }
const configured = {
  ...base,
  SMS_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'synthetic-auth-token',
  TWILIO_FROM: '+12025550123',
  SMS_HASH_KEY: Buffer.alloc(32, 3).toString('base64'),
}

describe('operator SMS configuration', () => {
  it('defaults off with conservative positive limits', () => {
    expect(loadConfig(base).SMS_PROVIDER).toBeUndefined()
    expect(loadConfig(base)).toMatchObject({
      SMS_RECIPIENT_MAX_PER_HOUR: 3,
      SMS_RECIPIENT_MAX_PER_DAY: 10,
      SMS_MAX_PER_HOUR: 100,
      SMS_ORGANIZATION_MAX_PER_DAY: 50,
    })
  })
  it('accepts both authentication and sender modes in every role', () => {
    for (const HOURMERE_ROLE of ['all', 'web', 'worker']) {
      expect(loadConfig({ ...configured, HOURMERE_ROLE }).SMS_PROVIDER).toBe('twilio')
      expect(
        loadConfig({
          ...configured,
          HOURMERE_ROLE,
          TWILIO_AUTH_TOKEN: '',
          TWILIO_FROM: '',
          TWILIO_API_KEY_SID: `SK${'2'.repeat(32)}`,
          TWILIO_API_KEY_SECRET: 'synthetic-api-key-secret',
          TWILIO_MESSAGING_SERVICE_SID: `MG${'3'.repeat(32)}`,
        }).SMS_PROVIDER,
      ).toBe('twilio')
    }
  })
  it('rejects missing, ambiguous and partial configuration', () => {
    for (const key of [
      'SMS_PROVIDER',
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_FROM',
      'SMS_HASH_KEY',
    ])
      expect(() => loadConfig({ ...configured, [key]: '' })).toThrow(/SMS/)
    for (const extra of [
      { TWILIO_API_KEY_SID: `SK${'2'.repeat(32)}` },
      {
        TWILIO_API_KEY_SID: `SK${'2'.repeat(32)}`,
        TWILIO_API_KEY_SECRET: 'synthetic-api-key-secret',
      },
      { TWILIO_MESSAGING_SERVICE_SID: `MG${'3'.repeat(32)}` },
    ])
      expect(() => loadConfig({ ...configured, ...extra })).toThrow(/exactly one/)
  })
  it('validates identifiers, keys, sender numbers and limits without exposing inputs', () => {
    for (const key of [
      'SMS_PROVIDER',
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_API_KEY_SID',
      'TWILIO_API_KEY_SECRET',
      'TWILIO_MESSAGING_SERVICE_SID',
      'TWILIO_FROM',
      'SMS_HASH_KEY',
    ]) {
      expect(() => loadConfig({ ...configured, [key]: 'private-invalid\nvalue' })).toThrow()
      expect(() => loadConfig({ ...configured, [key]: 'private-invalid\nvalue' })).not.toThrow(
        /private-invalid/,
      )
    }
    for (const key of [
      'SMS_RECIPIENT_MAX_PER_HOUR',
      'SMS_RECIPIENT_MAX_PER_DAY',
      'SMS_MAX_PER_HOUR',
      'SMS_ORGANIZATION_MAX_PER_DAY',
    ])
      for (const value of ['0', '-1', '0.5', 'NaN', ' ', '2147483648'])
        expect(() => loadConfig({ ...base, [key]: value })).toThrow(new RegExp(key))
    expect(() =>
      loadConfig({
        ...configured,
        SMS_HASH_KEY: Buffer.from(base.BETTER_AUTH_SECRET).toString('base64'),
      }),
    ).toThrow(/independent/)
  })
  it('reads SMS secret files and rejects conflicts, empty or unreadable files privately', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hourmere-sms-config-'))
    try {
      for (const name of ['TWILIO_AUTH_TOKEN', 'TWILIO_API_KEY_SECRET', 'SMS_HASH_KEY']) {
        const file = join(directory, name)
        const value = name === 'SMS_HASH_KEY' ? configured.SMS_HASH_KEY : 'synthetic-file-secret'
        writeFileSync(file, `${value}\n`)
        const env =
          name === 'TWILIO_API_KEY_SECRET'
            ? { ...configured, TWILIO_AUTH_TOKEN: '', TWILIO_API_KEY_SID: `SK${'2'.repeat(32)}` }
            : configured
        expect(
          loadConfig({ ...env, [name]: '', [`${name}_FILE`]: file })[name as 'SMS_HASH_KEY'],
        ).toBe(value)
        expect(() => loadConfig({ ...env, [name]: value, [`${name}_FILE`]: file })).toThrow(
          /set only/,
        )
        writeFileSync(file, '')
        expect(() => loadConfig({ ...env, [name]: '', [`${name}_FILE`]: file })).toThrow(
          /must not be empty/,
        )
        expect(() =>
          loadConfig({ ...env, [name]: '', [`${name}_FILE`]: `${file}-missing` }),
        ).toThrow(/cannot read/)
        expect(() =>
          loadConfig({ ...env, [name]: '', [`${name}_FILE`]: `${file}-missing` }),
        ).not.toThrow(new RegExp(directory))
      }
    } finally {
      rmSync(directory, { recursive: true })
    }
  })
})
