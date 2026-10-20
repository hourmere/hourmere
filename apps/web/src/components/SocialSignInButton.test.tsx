/// <reference types="node" />
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import googleDarkAsset from '../assets/identity/google-sign-in-dark.svg?raw'
import googleAsset from '../assets/identity/google-sign-in-light.svg?raw'
import microsoftSymbol from '../assets/identity/microsoft-symbol.svg'
import microsoftAsset from '../assets/identity/microsoft-symbol.svg?raw'
import { SocialSignInButton } from './SocialSignInButton.tsx'

const css = readFileSync('apps/web/src/components/SocialSignInButton.css', 'utf8')

describe('official social sign-in branding', () => {
  it('keeps the downloaded official assets intact and renders their marks decoratively', () => {
    expect(createHash('sha256').update(googleAsset).digest('hex')).toBe(
      '6587b180203a99da15c0a041018e15c94ffd9556c4b9855bdc69806081a93791',
    )
    expect(createHash('sha256').update(googleDarkAsset).digest('hex')).toBe(
      '2f7ecc307b1db0f1738456269ee2c4433b3a73c35060ced67a9afcfc6821e786',
    )
    expect(createHash('sha256').update(microsoftAsset).digest('hex')).toBe(
      '929f48f88c8ca7f3f5d294be47ec4caf51acc28ac25340c19a903125d7ecd84a',
    )
    render(
      <>
        <SocialSignInButton provider="google" disabled={false} opening={false} onClick={vi.fn()} />
        <SocialSignInButton
          provider="microsoft"
          disabled={false}
          opening={false}
          onClick={vi.fn()}
        />
      </>,
    )
    const google = screen.getByRole('button', { name: 'Continue with Google' })
    const mark = google.querySelector('.social-sign-in-google-mark')
    expect(mark?.getAttribute('aria-hidden')).toBe('true')
    for (const [theme, asset] of [
      ['light', googleAsset],
      ['dark', googleDarkAsset],
    ]) {
      const variant = mark?.querySelector(`.google-mark-${theme}`)
      const official = new DOMParser().parseFromString(asset ?? '', 'image/svg+xml')
      expect(variant?.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 40 40')
      expect(variant?.querySelector('mask path')?.getAttribute('d')).toBe(
        official.querySelector('mask path')?.getAttribute('d'),
      )
      // The crop retains the official theme's background behind the original G.
      expect(variant?.querySelector('svg > path')?.getAttribute('fill')).toBe(
        theme === 'dark' ? '#131314' : 'white',
      )
      expect(variant?.querySelector('svg > path')?.getAttribute('d')).toBe(
        official.querySelector('svg > path')?.getAttribute('d'),
      )
      expect(variant?.querySelector('.google-mark-gradient')).not.toBeNull()
      // The Figma gradient renders inline while its styles respect style-src 'self'.
      expect(variant?.querySelector('[style]')).toBeNull()
    }
    const microsoft = screen.getByRole('button', { name: 'Sign in with Microsoft' })
    const symbol = microsoft.querySelector('img')
    expect(symbol?.getAttribute('src')).toBe(microsoftSymbol)
    expect(symbol?.getAttribute('alt')).toBe('')
    expect(symbol?.getAttribute('width')).toBe('21')
    expect(symbol?.getAttribute('height')).toBe('21')
  })

  it('uses the required light/dark colors, type sizes and fixed logo padding', () => {
    const element = document.createElement('style')
    element.textContent = css
    document.head.appendChild(element)
    try {
      const rules = Array.from(element.sheet?.cssRules ?? [])
      const rule = (selector: string, list = rules): CSSStyleDeclaration => {
        const found = list.find((r) => 'selectorText' in r && r.selectorText === selector)
        expect(found, selector).toBeDefined()
        return (found as CSSStyleRule).style
      }
      const expectStyle = (selector: string, values: Record<string, string>, list = rules) => {
        const actual = rule(selector, list)
        const reference = document.createElement('i').style
        for (const [property, value] of Object.entries(values)) {
          reference.setProperty(property, value)
          expect(actual.getPropertyValue(property), `${selector} ${property}`).toBe(
            reference.getPropertyValue(property),
          )
        }
      }
      expectStyle('.social-sign-in-google', {
        height: '40px',
        border: '1px solid #747775',
        background: '#ffffff',
        color: '#1f1f1f',
        font: '500 14px / 20px "Google Sans", Arial, sans-serif',
      })
      expectStyle('.social-sign-in-google-mark', {
        width: '20px',
        height: '20px',
        'margin-right': '10px',
      })
      // A wrapper background would reintroduce a 20px square over the theme asset.
      expect(rule('.social-sign-in-google-mark').getPropertyValue('background')).toBe('')
      expect(rule('.social-sign-in-google-mark').getPropertyValue('background-color')).toBe('')
      expectStyle('.google-mark-light', { display: 'block' })
      expectStyle('.google-mark-dark', { display: 'none' })
      expectStyle('.social-sign-in-google-mark svg', { transform: 'translate(-10px, -10px)' })
      // Include the border and the official mask/crop offsets when measuring the logo inset.
      const google = rule('.social-sign-in-google')
      const logoX = Number(
        new DOMParser()
          .parseFromString(googleAsset, 'image/svg+xml')
          .querySelector('mask')
          ?.getAttribute('x'),
      )
      const cropX = Number.parseFloat(
        rule('.social-sign-in-google-mark svg').transform.match(/translate\(([^,]+)/)?.[1] ?? '',
      )
      expect(
        Number.parseFloat(google.borderLeftWidth) +
          Number.parseFloat(google.paddingLeft) +
          logoX +
          cropX,
      ).toBe(12)
      // Every gradient stop is copied from the official SVG, rather than approximated.
      for (const asset of [googleAsset, googleDarkAsset]) {
        const officialGradient = asset.match(/style="background:(conic-gradient[^;]+);/)?.[1]
        expect(officialGradient).toBeDefined()
        expectStyle('.social-sign-in-google-mark .google-mark-gradient', {
          background: officialGradient ?? '',
        })
      }
      expectStyle('.social-sign-in-microsoft', {
        height: '41px',
        border: '1px solid #8c8c8c',
        background: '#ffffff',
        color: '#5e5e5e',
        font: '600 15px / 20px "Segoe UI", Arial, sans-serif',
        padding: '0 11px',
        gap: '11px',
      })
      const dark = rules.find(
        (r) => r instanceof CSSMediaRule && r.conditionText === '(prefers-color-scheme: dark)',
      ) as CSSMediaRule
      expect(dark.conditionText).toBe('(prefers-color-scheme: dark)')
      const darkRules = Array.from(dark.cssRules)
      expectStyle('.google-mark-light', { display: 'none' }, darkRules)
      expectStyle('.google-mark-dark', { display: 'block' }, darkRules)
      expectStyle(
        '.social-sign-in-google',
        {
          background: '#131314',
          'border-color': '#8e918f',
          color: '#e3e3e3',
        },
        darkRules,
      )
      expectStyle(
        '.social-sign-in-microsoft',
        {
          background: '#2f2f2f',
          color: '#ffffff',
        },
        darkRules,
      )
    } finally {
      element.remove()
    }
  })
})
