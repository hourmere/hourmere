import { expect, it } from 'vitest'
import styles from '../styles.css?raw'

it('keeps narrow save actions compact and applies the measured viewport budget', () => {
  const bar = styles.match(/\.sticky-form-actions \{([^{}]*)\}/)?.[1]
  expect(bar).toContain('display: grid;')
  expect(bar).toContain('grid-template-columns: auto minmax(0, 1fr);')
  expect(bar).toContain('gap: var(--space-2);')
  expect(bar).toContain('padding: var(--space-2);')
  expect(styles).toMatch(
    /@media \(min-width: 480px\)\s*\{\s*\.sticky-form-actions \{\s*display: flex;/,
  )
  expect(styles).toMatch(/\.sticky-form-actions\[data-sticky="false"\] \{\s*position: static;/)
})
