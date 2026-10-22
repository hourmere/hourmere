import { describe, expect, it } from 'vitest'
import {
  notificationRecipientHash,
  notificationSuppressionReason,
  signInRecipientHash,
} from './mail-limits.ts'

const SECRET = 'synthetic-notification-secret'

describe('notification mail budgets', () => {
  const empty = { instanceHour: 0, recipientHour: 0, recipientDay: 0 }
  it('normalizes address case and surrounding whitespace before hashing', () => {
    expect(notificationRecipientHash('  Ada@Example.TEST ', SECRET)).toEqual(
      notificationRecipientHash('ada@example.test', SECRET),
    )
    expect(notificationRecipientHash('ada@example.test', SECRET)).toHaveLength(32)
    expect(notificationRecipientHash('other@example.test', SECRET)).not.toEqual(
      notificationRecipientHash('ada@example.test', SECRET),
    )
  })
  it('uses a purpose-derived HMAC key for private, domain-separated recipient hashes', () => {
    expect(notificationRecipientHash('ada@example.test', SECRET).toString('hex')).toBe(
      'bfe0d34e26bfea7caac31af9ea45668f1f75a1ae61aa6c5ed97a6ed0c571357f',
    )
    expect(signInRecipientHash('ada@example.test', SECRET).toString('hex')).toBe(
      'bd3a08a707c64067e8417536a0ebd83caa8c4243da2418b81e4085377550890f',
    )
    expect(notificationRecipientHash('ada@example.test', 'another-synthetic-secret')).not.toEqual(
      notificationRecipientHash('ada@example.test', SECRET),
    )
    expect(signInRecipientHash('ada@example.test', 'another-synthetic-secret')).not.toEqual(
      signInRecipientHash('ada@example.test', SECRET),
    )
    expect(signInRecipientHash('  ADA@Example.TEST ', SECRET)).toEqual(
      signInRecipientHash('ada@example.test', SECRET),
    )
    expect(signInRecipientHash('ada@example.test', SECRET)).not.toEqual(
      notificationRecipientHash('ada@example.test', SECRET),
    )
  })
  it.each([
    ['ada+news@gmail.com', 'ada@gmail.com'],
    ['a.da@gmail.com', 'ada@gmail.com'],
    ['ada@bücher.test', 'ada@xn--bcher-kva.test'],
  ])('does not merge address variants %s and %s', (first, second) => {
    expect(notificationRecipientHash(first, SECRET)).not.toEqual(
      notificationRecipientHash(second, SECRET),
    )
    expect(signInRecipientHash(first, SECRET)).not.toEqual(signInRecipientHash(second, SECRET))
  })
  it.each([
    [{ recipientHour: 4, recipientDay: 19 }, undefined],
    [{ recipientHour: 5 }, 'recipient_hourly_limit'],
    [{ recipientDay: 20 }, 'recipient_daily_limit'],
    [{ instanceHour: 100 }, 'instance_hourly_limit'],
  ] as const)('applies default rolling limits at the boundary: %j', (counts, reason) => {
    expect(notificationSuppressionReason({}, { ...empty, ...counts }, true)).toBe(reason)
  })
  it('allows hosts until the integer 120 percent ceiling and ignores recipient counts', () => {
    expect(
      notificationSuppressionReason(
        {},
        { instanceHour: 119, recipientHour: 500, recipientDay: 2000 },
        false,
      ),
    ).toBeUndefined()
    expect(notificationSuppressionReason({}, { ...empty, instanceHour: 120 }, false)).toBe(
      'instance_hourly_limit',
    )
    expect(
      notificationSuppressionReason({ mailMaxPerHour: 4 }, { ...empty, instanceHour: 4 }, false),
    ).toBe('instance_hourly_limit')
  })
  it('makes only the instance cap unlimited when configured as zero', () => {
    expect(
      notificationSuppressionReason({ mailMaxPerHour: 0 }, { ...empty, instanceHour: 1000 }, true),
    ).toBeUndefined()
    expect(
      notificationSuppressionReason(
        { mailMaxPerHour: 0 },
        { ...empty, instanceHour: 1000, recipientHour: 5 },
        true,
      ),
    ).toBe('recipient_hourly_limit')
  })
  it('honors configured hourly and daily recipient caps', () => {
    const limits = { mailRecipientMaxPerHour: 2, mailRecipientMaxPerDay: 3 }
    expect(notificationSuppressionReason(limits, { ...empty, recipientHour: 2 }, true)).toBe(
      'recipient_hourly_limit',
    )
    expect(notificationSuppressionReason(limits, { ...empty, recipientDay: 3 }, true)).toBe(
      'recipient_daily_limit',
    )
  })
})
