import { runInNewContext } from 'node:vm'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inlineAsset } from './sign-in-confirm-testing.ts'

const fixture = vi.hoisted(() => ({ value: 'Fixture </script> title' as unknown }))
vi.mock('@hourmere/core/locales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hourmere/core/locales')>()
  return {
    ...actual,
    localeRegistry: {
      ...actual.localeRegistry,
      qaa: {
        code: 'qaa',
        nativeName: 'Fixture locale',
        fallbacks: ['en'],
        formatLocale: 'fr-FR',
        direction: 'ltr',
      },
    },
  }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
      String(args[0]).endsWith('/i18n/catalogues/qaa.json')
        ? JSON.stringify({ title: fixture.value })
        : actual.readFileSync(...args),
  }
})
afterEach(() => {
  fixture.value = 'Fixture </script> title'
  vi.resetModules()
})

async function page(headers: Record<string, string> = {}) {
  const { signInConfirmPage } = await import('./sign-in-confirm.ts')
  const response = await new Hono().get('/confirm', signInConfirmPage).request('/confirm', {
    headers,
  })
  expect(response.status).toBe(200)
  return response.text()
}

describe('registered sign-in confirmation locales', () => {
  it('discovers a test-only registered locale, negotiates regional tags and falls back per word', async () => {
    const html = await page({ 'Accept-Language': 'qaa-CA,en;q=0.8' })
    expect(html).toContain('<html lang="qaa">')
    expect(html).toContain('<title>Fixture &lt;/script&gt; title</title>')
    expect(html).toContain('Press the button to finish signing in.')
    expect(html).toContain('<option value="qaa" lang="qaa" selected>Fixture locale</option>')
    expect(inlineAsset(html, 'script')).not.toContain('</script>')
    expect(inlineAsset(html, 'script')).toContain('function setLanguage(language)')
  })

  it('switches to the registered fixture in place, using English for missing words', async () => {
    const html = await page()
    const nodes = new Map<string, { textContent: string; value?: string; hidden?: boolean }>()
    const node = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, { textContent: '' })
      return Object.assign(nodes.get(id) as { textContent: string }, {
        addEventListener() {},
        setAttribute() {},
      })
    }
    const document = {
      documentElement: { lang: 'en', dir: 'ltr' },
      title: '',
      cookie: '',
      getElementById: node,
      querySelector: () => node('button'),
    }
    const context = {
      document,
      location: { hash: '', protocol: 'https:' },
      URLSearchParams,
      localStorage: { setItem() {} },
    }
    runInNewContext(inlineAsset(html, 'script'), context)
    runInNewContext("setLanguage('qaa')", context)
    expect(document.documentElement.lang).toBe('qaa')
    expect(document.title).toBe('Fixture </script> title')
    expect(node('confirm-instruction').textContent).toBe('Press the button to finish signing in.')
    expect(document.cookie).toContain('hourmere-language=qaa;')
  })

  it.each([42, 'Fixture {unexpected}', 'Fixture {'])(
    'rejects a malformed registered catalogue %j',
    async (value) => {
      fixture.value = value
      await expect(page()).rejects.toThrow('Malformed confirmation catalogue: qaa')
    },
  )
})
