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

const luminance = (channels: number[]) =>
  channels
    .map((channel) => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    .reduce((sum, value, index) => sum + value * ([0.2126, 0.7152, 0.0722][index] ?? 0), 0)
const rgb = (color: string): number[] => {
  // jsdom retains custom properties in computed colors instead of substituting them.
  const variable = color.match(/^var\((--[\w-]+)\)$/)?.[1]
  if (variable)
    return rgb(getComputedStyle(document.documentElement).getPropertyValue(variable).trim())
  return color.startsWith('#')
    ? (color.slice(1).match(/../g) ?? []).map((channel) => Number.parseInt(channel, 16))
    : (color.match(/[\d.]+/g) ?? []).map(Number)
}
const contrast = (foreground: number[], background: number[], opacity: number) => {
  const composited = foreground.map(
    (channel, index) => channel * opacity + (background[index] ?? 0) * (1 - opacity),
  )
  return (luminance(background) + 0.05) / (luminance(composited) + 0.05)
}

it('keeps the light footer text and cobalt mark comfortably above 4.5:1 after opacity', () => {
  const style = document.createElement('style')
  style.textContent = `${readFileSync('apps/web/src/styles.css', 'utf8')}\n${publicStyles}`
  const wrapper = document.createElement('div')
  wrapper.className = 'public'
  wrapper.innerHTML = '<footer class="public-footer"><a>Powered by Hourmere</a></footer>'
  document.head.append(style)
  document.body.append(wrapper)
  try {
    const footer = wrapper.querySelector('footer') as HTMLElement
    const link = wrapper.querySelector('a') as HTMLAnchorElement
    const background = rgb(getComputedStyle(document.body).background)
    const opacity = Number(getComputedStyle(footer).opacity)
    const cobalt =
      readFileSync('apps/web/src/assets/hourmere-mark.svg', 'utf8').match(
        /stroke="#([0-9a-f]{6})"/i,
      )?.[1] ?? ''
    const mark = (cobalt.match(/../g) ?? []).map((channel) => Number.parseInt(channel, 16))
    expect(background).toHaveLength(3)
    expect(mark).toHaveLength(3)
    expect(contrast(rgb(getComputedStyle(link).color), background, opacity)).toBeGreaterThan(5)
    expect(contrast(mark, background, opacity)).toBeGreaterThan(5)
  } finally {
    style.remove()
    wrapper.remove()
  }
})
