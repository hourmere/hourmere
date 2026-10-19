/// <reference types="node" />
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
    expect(mark?.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 40 40')
    expect(mark?.querySelector('mask path')?.getAttribute('d')).toBe(
      new DOMParser()
        .parseFromString(googleAsset, 'image/svg+xml')
        .querySelector('mask path')
        ?.getAttribute('d'),
    )
    expect(mark?.querySelector('.google-mark-gradient')).not.toBeNull()
    // The Figma export's gradient must render inline and all styles must work with style-src 'self'.
    expect(mark?.querySelector('[style]')).toBeNull()
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
        padding: '0 12px',
        border: '1px solid #747775',
        background: '#ffffff',
        color: '#1f1f1f',
        font: '500 14px / 20px "Google Sans", Arial, sans-serif',
      })
      expectStyle('.social-sign-in-google-mark', {
        width: '20px',
        height: '20px',
        'margin-right': '10px',
        background: '#ffffff',
      })
      expectStyle('.social-sign-in-google-mark svg', { transform: 'translate(-10px, -10px)' })
      // Every gradient stop is copied from the official SVG, rather than approximated.
      const officialGradient = googleAsset.match(/style="background:(conic-gradient[^;]+);/)?.[1]
      expect(officialGradient).toBeDefined()
      expectStyle('.social-sign-in-google-mark .google-mark-gradient', {
        background: officialGradient ?? '',
      })
      expectStyle('.social-sign-in-microsoft', {
        height: '41px',
        border: '1px solid #8c8c8c',
        background: '#ffffff',
        color: '#5e5e5e',
        font: '600 15px / 20px "Segoe UI", Arial, sans-serif',
        padding: '0 11px',
        gap: '11px',
      })
      const dark = rules.find((r) => r instanceof CSSMediaRule) as CSSMediaRule
      expect(dark.conditionText).toBe('(prefers-color-scheme: dark)')
      const darkRules = Array.from(dark.cssRules)
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
