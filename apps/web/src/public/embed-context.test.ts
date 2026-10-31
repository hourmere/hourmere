import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { EMBED_ID, embedOrigin } from '@hourmere/core/embed'
import { explicitLanguage } from '@hourmere/core/language'
import { createContext, useContext } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  embedMessageContext,
  embedParentRedirectAllowed,
  notifyEmbedBooked,
  notifyEmbedReady,
} from './embed-context.ts'

afterEach(() => window.history.replaceState(null, '', '/'))

describe('child embed message context', () => {
  it.each([
    ['', true],
    ['?parentRedirect=enabled', true],
    ['?parentRedirect=disabled', false],
    ['?parentRedirect=true', false],
    ['?parentRedirect=', false],
    ['?parentRedirect=enabled&parentRedirect=enabled', false],
  ])('only honors an absent manual marker or one enabled widget marker (%s)', (query, allowed) => {
    window.history.replaceState(null, '', `/embed/ada/intro${query}`)
    expect(embedParentRedirectAllowed()).toBe(allowed)
  })
  it('detects removal of the active-widget restriction with a real source-copy assertion failure', () => {
    const original = readFileSync('apps/web/src/public/embed-context.ts', 'utf8')
    const modified = original.replace(
      "return values.length === 0 || (values.length === 1 && values[0] === 'enabled')",
      'return true',
    )
    expect(modified).not.toBe(original)
    const source = stripTypeScriptTypes(modified)
      .replace(/^import .*\n/gm, '')
      .replace(/^export /gm, '')
    const copy = new Function(
      'EMBED_ID',
      'embedOrigin',
      'explicitLanguage',
      'createContext',
      'useContext',
      `${source}\nreturn { embedParentRedirectAllowed }`,
    )(EMBED_ID, embedOrigin, explicitLanguage, createContext, useContext) as {
      embedParentRedirectAllowed: typeof embedParentRedirectAllowed
    }
    window.history.replaceState(null, '', '/embed/ada/intro?parentRedirect=disabled')
    expect(embedParentRedirectAllowed()).toBe(false)
    expect(() => expect(copy.embedParentRedirectAllowed()).toBe(false)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it('discloses only the saved capability and correlation ID to the exact parent', () => {
    const postMessage = vi.fn()
    vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window)
    window.history.replaceState(
      null,
      '',
      '/embed/ada/intro?parentOrigin=https%3A%2F%2Fparent.example&embedId=abcdefghijklmnop1234',
    )
    notifyEmbedReady(false)
    notifyEmbedReady(true)
    expect(postMessage.mock.calls).toEqual([
      [
        { type: 'hourmere:ready', id: 'abcdefghijklmnop1234', allowEmbedParent: false },
        'https://parent.example',
      ],
      [
        { type: 'hourmere:ready', id: 'abcdefghijklmnop1234', allowEmbedParent: true },
        'https://parent.example',
      ],
    ])
    window.history.replaceState(null, '', '/embed/ada/intro')
    notifyEmbedReady(true)
    expect(postMessage).toHaveBeenCalledTimes(2)
  })
  it('refuses duplicate parent origins before posting any completion signal', () => {
    const postMessage = vi.fn()
    vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window)
    const query = new URLSearchParams({
      parentOrigin: 'https://parent.example',
      embedId: 'abcdefghijklmnop1234',
    })
    window.history.replaceState(null, '', `/embed/ada/intro?${query}`)
    notifyEmbedBooked()
    expect(postMessage.mock.calls).toEqual([
      [{ type: 'hourmere:booked', id: 'abcdefghijklmnop1234' }, 'https://parent.example'],
    ])
    postMessage.mockClear()
    for (const secondOrigin of ['https://parent.example', 'https://other.example', '']) {
      const duplicate = new URLSearchParams(query)
      duplicate.append('parentOrigin', secondOrigin)
      window.history.replaceState(null, '', `/embed/ada/intro?${duplicate}`)
      expect(embedMessageContext()).toBeUndefined()
      notifyEmbedBooked()
      expect(postMessage).not.toHaveBeenCalled()
    }
  })
})
