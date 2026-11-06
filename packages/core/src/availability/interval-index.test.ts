import { describe, expect, it } from 'vitest'
import { intervalIndex } from './interval-index.ts'

describe('intervalIndex', () => {
  it('finds nested and unsorted intervals without including touching endpoints', () => {
    const intervals = [
      { start: 20n, end: 30n },
      { start: 0n, end: 100n },
      { start: 10n, end: 20n },
      { start: 15n, end: 16n },
      { start: 21n, end: 22n },
    ]
    expect(intervalIndex(intervals)(20n, 21n)).toEqual([intervals[1], intervals[0]])
  })

  it('prunes distant intervals rather than scanning the entire calendar per candidate', () => {
    let reads = 0
    const intervals = Array.from({ length: 3000 }, (_, i) => ({
      get start() {
        reads++
        return BigInt(i * 10)
      },
      get end() {
        reads++
        return BigInt(i * 10 + 5)
      },
    }))
    const query = intervalIndex(intervals)
    reads = 0
    expect(query(15001n, 15002n)).toHaveLength(1)
    expect(reads).toBeLessThan(50)
  })

  it('matches a linear oracle over seeded overlapping and nested intervals', () => {
    let seed = 991
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    const intervals = Array.from({ length: 300 }, () => {
      const start = BigInt(random(1000))
      return { start, end: start + BigInt(random(500) + 1) }
    })
    const query = intervalIndex(intervals)
    for (let i = 0; i < 100; i++) {
      const start = BigInt(random(1500))
      const end = start + BigInt(random(100) + 1)
      expect(query(start, end)).toEqual(
        intervals
          .filter((interval) => interval.start < end && interval.end > start)
          .sort((a, b) => Number(a.start - b.start)),
      )
    }
  })
})
