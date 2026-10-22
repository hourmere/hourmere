import { describe, expect, it } from 'vitest'
import { notificationRecipientHash, notificationSuppressionReason } from './mail-limits.ts'

describe('notification mail budgets', () => {
  const empty = { instanceHour: 0, recipientHour: 0, recipientDay: 0 }
  it('normalizes address case and surrounding whitespace before hashing', () => {
    expect(notificationRecipientHash('  Ada@Example.TEST ')).toEqual(
      notificationRecipientHash('ada@example.test'),
    )
    expect(notificationRecipientHash('ada@example.test')).toHaveLength(32)
    expect(notificationRecipientHash('other@example.test')).not.toEqual(
      notificationRecipientHash('ada@example.test'),
    )
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
