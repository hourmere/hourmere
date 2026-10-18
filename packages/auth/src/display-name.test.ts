import { describe, expect, it } from 'vitest'
import { DISPLAY_NAME_MAX_LENGTH, sanitizeInitialDisplayName } from './display-name.ts'

describe('initial display names', () => {
  it.each([
    ['  Ada Lovelace 👩‍💻  ', 'Ada Lovelace 👩‍💻'],
    ['Ada\r\nLovelace\tHopper\u0085Grace\u2028B\u2029C\0D', 'Ada Lovelace Hopper Grace B C D'],
    ['A'.repeat(DISPLAY_NAME_MAX_LENGTH + 1), 'A'.repeat(DISPLAY_NAME_MAX_LENGTH)],
    [`${'A'.repeat(DISPLAY_NAME_MAX_LENGTH - 1)}😀`, 'A'.repeat(DISPLAY_NAME_MAX_LENGTH - 1)],
    [
      `${'A'.repeat(DISPLAY_NAME_MAX_LENGTH - 2)}😀`,
      `${'A'.repeat(DISPLAY_NAME_MAX_LENGTH - 2)}😀`,
    ],
    [`${'A'.repeat(DISPLAY_NAME_MAX_LENGTH - 1)} B`, 'A'.repeat(DISPLAY_NAME_MAX_LENGTH - 1)],
    ['A\ud800B', 'A\ufffdB'],
    ['\t\r\n\u2028\u2029', ''],
    ['', ''],
  ])('sanitizes optional sign-up metadata (%#)', (input, expected) => {
    const name = sanitizeInitialDisplayName(input)
    expect(name).toBe(expected)
    expect(name.length).toBeLessThanOrEqual(DISPLAY_NAME_MAX_LENGTH)
    expect(name.isWellFormed()).toBe(true)
    expect(/[\p{Cc}\p{Zl}\p{Zp}]/u.test(name)).toBe(false)
    expect(name).toBe(name.trim())
  })
})
