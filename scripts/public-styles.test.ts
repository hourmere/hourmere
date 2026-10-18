/// <reference lib="dom" />
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const publicStyles = readFileSync('apps/web/src/public/public.css', 'utf8')

it('keeps public styles scoped so visiting a booking page cannot restyle admin fields', () => {
  const style = document.createElement('style')
  style.textContent = publicStyles
  document.head.append(style)
  let selectors = 0
  try {
    function inspect(rules: CSSRuleList) {
      for (const rule of rules) {
        if ('selectorText' in rule) {
          for (const selector of (rule as CSSStyleRule).selectorText.split(',')) {
            expect(selector.trim(), 'public selector must require the public container').toMatch(
              /^\.public(?:-embedded)?(?:$|[\s.:#[>+~])/,
            )
            selectors++
          }
        } else if ('cssRules' in rule) inspect((rule as CSSGroupingRule).cssRules)
      }
    }
    expect(style.sheet).not.toBeNull()
    inspect((style.sheet as CSSStyleSheet).cssRules)
    expect(selectors).toBeGreaterThan(100)
  } finally {
    style.remove()
  }
})
