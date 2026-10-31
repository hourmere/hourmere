import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

interface PackageManifest {
  devDependencies?: Record<string, string>
}

interface TestDom {
  window: {
    document: {
      querySelector(selector: string): { textContent: string | null } | null
    }
    close(): void
  }
}

const manifest = (path: string): PackageManifest =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as PackageManifest
const root = manifest('../package.json')
const rootRequire = createRequire(new URL('../package.json', import.meta.url))

describe('Vitest environment dependency ownership', () => {
  it('pins jsdom at the root that owns Vitest and keeps workspace versions aligned', () => {
    const pinned = root.devDependencies?.jsdom
    expect(pinned, 'The root test runner must directly own its jsdom environment').toMatch(
      /^\d+\.\d+\.\d+$/,
    )
    for (const path of ['../apps/site/package.json', '../apps/web/package.json']) {
      expect(manifest(path).devDependencies?.jsdom, path).toBe(pinned)
    }
  })

  it('resolves and loads the pinned jsdom from the installed Vitest package', () => {
    let failure: unknown
    let environment: { version: unknown; JSDOM: new (html: string) => TestDom } | undefined
    try {
      // Native environment loading starts at Vitest, rather than the web/site workspace.
      const vitestRequire = createRequire(rootRequire.resolve('vitest/package.json'))
      const jsdomPath = vitestRequire.resolve('jsdom')
      const { JSDOM } = vitestRequire(jsdomPath) as {
        JSDOM: new (html: string) => TestDom
      }
      const { version } = vitestRequire('jsdom/package.json') as { version: unknown }
      environment = { version, JSDOM }
    } catch (error) {
      failure = error
    }
    expect(failure, 'The installed Vitest package must be able to load jsdom').toBeUndefined()
    expect(environment).toBeDefined()
    if (!environment) return
    expect(environment.version).toBe(root.devDependencies?.jsdom)
    const dom = new environment.JSDOM('<p data-environment-fixture>Vitest DOM</p>')
    try {
      expect(dom.window.document.querySelector('[data-environment-fixture]')?.textContent).toBe(
        'Vitest DOM',
      )
    } finally {
      dom.window.close()
    }
  })
})
