import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { embedOrigin, publicBookingPath } from '@hourmere/core/embed'
import { explicitLanguage } from '@hourmere/core/language'
import { describe, expect, it, vi } from 'vitest'
import { randomHex } from '../random.ts'
import { widgetLanguage, widgetMessages } from './language.ts'
import type * as Widget from './widget.ts'

function sourceCopy(mutate: (source: string) => string): typeof Widget {
  const original = readFileSync('apps/web/src/embed/widget.ts', 'utf8')
  const modified = mutate(original)
  expect(modified).not.toBe(original)
  const source = stripTypeScriptTypes(modified)
    .replace(/^import .*\n/gm, '')
    .replace(/^export /gm, '')
  // Keep the actual widget dependencies, including Vite's translated message catalogues,
  // while evaluating a source copy without altering the production module on disk.
  return new Function(
    'embedOrigin',
    'publicBookingPath',
    'explicitLanguage',
    'randomHex',
    'widgetLanguage',
    'widgetMessages',
    `${source}\nreturn { initInline }`,
  )(embedOrigin, publicBookingPath, explicitLanguage, randomHex, widgetLanguage, widgetMessages)
}

function sandbox(module: typeof Widget, flag?: unknown, extra: Record<string, unknown> = {}) {
  const element = document.createElement('div')
  document.body.append(element)
  const handle = module.initInline({ element, url: 'https://hourmere.test/ada/intro' })
  try {
    if (flag !== undefined) {
      const src = new URL(handle.iframe.src)
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: src.origin,
          source: handle.iframe.contentWindow,
          data: {
            type: 'hourmere:ready',
            id: src.searchParams.get('embedId'),
            allowEmbedParent: flag,
            ...extra,
          },
        }),
      )
    }
    return handle.iframe.getAttribute('sandbox') ?? ''
  } finally {
    handle.destroy()
    element.remove()
  }
}

describe('widget source-copy mutation controls', () => {
  it.each([
    {
      name: 'default restrictive sandbox',
      mutate: (source: string) =>
        source.replace(
          "iframe.setAttribute('sandbox', sandbox)",
          "iframe.setAttribute('sandbox', sandbox + ' allow-top-navigation-by-user-activation')",
        ),
      verify: (module: typeof Widget) =>
        expect(sandbox(module)).not.toContain('allow-top-navigation'),
    },
    {
      name: 'saved parent opt-in',
      mutate: (source: string) =>
        source.replace(
          'data.allowEmbedParent && !parentNavigation && !downgraded',
          '!parentNavigation && !downgraded',
        ),
      verify: (module: typeof Widget) =>
        expect(sandbox(module, false)).not.toContain('allow-top-navigation'),
    },
    {
      name: 'strict capability type',
      mutate: (source: string) =>
        source.replace("typeof data.allowEmbedParent !== 'boolean'", 'false'),
      verify: (module: typeof Widget) =>
        expect(sandbox(module, 'true')).not.toContain('allow-top-navigation'),
    },
    {
      name: 'navigation-free message shape',
      mutate: (source: string) => source.replace('Object.keys(data).length !== 3', 'false'),
      verify: (module: typeof Widget) =>
        expect(sandbox(module, true, { url: 'https://attacker.example' })).not.toContain(
          'allow-top-navigation',
        ),
    },
  ])('detects removing $name with a real assertion failure', ({ mutate, verify }) => {
    verify(sourceCopy((source) => `${source}\n// baseline source copy`))
    expect(() => verify(sourceCopy(mutate))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it.each([
    {
      name: 'bounded readiness wait',
      mutate: (source: string) => source.replace('}, 5000)', '}, 500000)'),
      verify: (iframe: HTMLIFrameElement) => {
        expect(iframe.inert).toBe(false)
        expect(iframe.hasAttribute('tabindex')).toBe(false)
        expect(iframe.style.pointerEvents).toBe('')
      },
    },
    {
      name: 'restricted fallback sandbox',
      mutate: (source: string) =>
        source.replace(
          "iframe = retiring.cloneNode(false) as HTMLIFrameElement\n        iframe.setAttribute('sandbox', sandbox)",
          'iframe = retiring.cloneNode(false) as HTMLIFrameElement',
        ),
      verify: (iframe: HTMLIFrameElement) =>
        expect(iframe.getAttribute('sandbox')).not.toContain('allow-top-navigation'),
    },
    {
      name: 'restricted fallback marker',
      mutate: (source: string) =>
        source.replace(
          "target.searchParams.set('parentRedirect', 'disabled')\n        id = randomHex(16)",
          'id = randomHex(16)',
        ),
      verify: (iframe: HTMLIFrameElement) =>
        expect(new URL(iframe.src).searchParams.get('parentRedirect')).toBe('disabled'),
    },
    {
      name: 'retired privileged browsing context removal',
      mutate: (source: string) =>
        source.replace('retiring.replaceWith(iframe)', 'retiring.after(iframe)'),
      verify: (iframe: HTMLIFrameElement) =>
        expect(iframe.parentElement?.querySelectorAll('iframe')).toHaveLength(1),
    },
    {
      name: 'retired downgraded browsing context removal',
      mutate: (source: string) =>
        source.replace('if (parentNavigation || downgraded)', 'if (parentNavigation)'),
      verify: (iframe: HTMLIFrameElement) => expect(iframe.isConnected).toBe(false),
    },
    {
      name: 'no late reload after input becomes available',
      mutate: (source: string) => source.replace('if (ready ||', 'if (false ||'),
      verify: (iframe: HTMLIFrameElement) => {
        const original = iframe.src
        const src = new URL(original)
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: src.origin,
            source: iframe.contentWindow,
            data: {
              type: 'hourmere:ready',
              id: src.searchParams.get('embedId'),
              allowEmbedParent: true,
            },
          }),
        )
        expect(iframe.src).toBe(original)
      },
    },
    {
      name: 'destroyed frame timer cleanup',
      mutate: (source: string) =>
        source.replace('destroyed = true\n      clearTimeout(readyTimeout)', 'destroyed = true'),
      verify: (_iframe: HTMLIFrameElement, destroy: () => void) => {
        destroy()
        expect(vi.getTimerCount()).toBe(0)
      },
    },
  ])('detects removing $name with a real assertion failure', ({ name, mutate, verify }) => {
    vi.useFakeTimers()
    const check = (module: typeof Widget) => {
      const element = document.createElement('div')
      document.body.append(element)
      const handle = module.initInline({ element, url: 'https://hourmere.test/ada/intro' })
      const retiring = handle.iframe
      try {
        if (name !== 'destroyed frame timer cleanup') {
          const src = new URL(handle.iframe.src)
          window.dispatchEvent(
            new MessageEvent('message', {
              origin: src.origin,
              source: handle.iframe.contentWindow,
              data: {
                type: 'hourmere:ready',
                id: src.searchParams.get('embedId'),
                allowEmbedParent: true,
              },
            }),
          )
          if (name === 'retired downgraded browsing context removal') {
            const upgraded = new URL(handle.iframe.src)
            window.dispatchEvent(
              new MessageEvent('message', {
                origin: upgraded.origin,
                source: handle.iframe.contentWindow,
                data: {
                  type: 'hourmere:ready',
                  id: upgraded.searchParams.get('embedId'),
                  allowEmbedParent: false,
                },
              }),
            )
          }
          vi.advanceTimersByTime(5000)
        }
        verify(
          name === 'retired downgraded browsing context removal' ? retiring : handle.iframe,
          handle.destroy,
        )
      } finally {
        handle.destroy()
        element.remove()
        vi.clearAllTimers()
      }
    }
    try {
      check(sourceCopy((source) => `${source}\n// baseline source copy`))
      expect(() => check(sourceCopy(mutate))).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
