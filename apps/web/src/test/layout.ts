import { expect } from 'vitest'
import publicStyles from '../public/public.css?raw'
import styles from '../styles.css?raw'

/** Verify the real CSS provides a vertical gap in jsdom, which has no layout engine. */
export function expectStackGap(element: HTMLElement, compactButton?: HTMLElement) {
  const sheet = document.createElement('style')
  sheet.textContent = styles + publicStyles.replace(/^@import[^;]+;/m, '')
  document.head.append(sheet)
  try {
    const computed = getComputedStyle(element)
    expect(computed.display).toBe('grid')
    expect(computed.gap).toBe('var(--space-3)')
    if (compactButton) expect(getComputedStyle(compactButton).justifySelf).toBe('start')
    expect(getComputedStyle(document.documentElement).getPropertyValue('--space-3').trim()).toBe(
      '12px',
    )
  } finally {
    sheet.remove()
  }
}
