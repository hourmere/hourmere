import { expect, it } from 'vitest'
import styles from './styles.css?raw'

it('spaces card-list panels with the grid gap alone', () => {
  expect(styles).toMatch(/\.card-list\s*\{[^{}]*gap: var\(--space-3\);/)
  expect(styles).toMatch(/\.card-list > \.panel\s*\{\s*margin: 0;/)
})

it('retains block ellipsis on booking links for coarse pointers', () => {
  expect(styles).toMatch(
    /\.booking-link a,\s*\.booking-link \.preview\s*\{[^{}]*display: block;[^{}]*overflow: hidden;[^{}]*text-overflow: ellipsis;[^{}]*white-space: nowrap;/,
  )
  const coarse = styles.slice(styles.indexOf('@media (pointer: coarse)'))
  for (const match of coarse.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1]?.includes('.booking-link a')) {
      expect(match[2]).not.toMatch(/display:\s*(inline-)?flex/)
    }
  }
  expect(coarse).toMatch(/\.booking-link a\s*\{[^{}]*min-height: 44px;/)
})
