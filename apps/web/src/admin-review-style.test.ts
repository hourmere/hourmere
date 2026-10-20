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

it('keeps long booking paths from sizing table columns or the editor field grid', () => {
  // Without containment the nowrap path sets the column's minimum width (the title column
  // collapses to single characters) and widens the slug hint past narrow viewports.
  expect(styles).toMatch(/\n\.booking-link\s*\{[^{}]*contain: inline-size;/)
  expect(styles).toMatch(
    /@container data-table \(min-width: 880px\)\s*\{\s*\.table \.booking-link\s*\{\s*flex-wrap: nowrap;/,
  )
})

it('contains the absolute hidden new-tab hint within its clipped booking link', () => {
  expect(styles).toMatch(
    /\.booking-link a,\s*\.booking-link \.preview\s*\{[^{}]*position: relative;/,
  )
})
