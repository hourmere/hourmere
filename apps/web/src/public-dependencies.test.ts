// @vitest-environment node
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { interfaceLanguages } from '@hourmere/core/language'
import { build } from 'vite'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { isShellAsset } from '../pwa/build.ts'
import type { Catalog } from './i18n/catalogues.ts'

const common = import.meta.glob<Catalog>('./i18n/catalogues/*/common.ts', {
  eager: true,
  import: 'common',
})
const widget = import.meta.glob<Catalog>('./i18n/catalogues/*/widget.ts', {
  eager: true,
  import: 'widget',
})
const nonEnglishCatalogue = /\/i18n\/catalogues\/(?!en\/)[^/]+\/(common|admin|widget)\.ts$/

beforeAll(() => {
  // Vite otherwise inherits Vitest's NODE_ENV and keeps the development catalogue loaders.
  vi.stubEnv('NODE_ENV', 'production')
})

afterAll(() => {
  vi.unstubAllEnvs()
})

function bundleOutputs(result: Awaited<ReturnType<typeof build>>) {
  return (Array.isArray(result) ? result : [result]).flatMap((bundle) => {
    if (!('output' in bundle)) throw new Error('Unexpected watch build')
    return bundle.output
  })
}

it('keeps admin and non-English catalogue strings outside the static public bundle', async () => {
  const result = await build({
    root: resolve('apps/web'),
    configFile: resolve('apps/web/vite.config.ts'),
    publicDir: false,
    logLevel: 'silent',
    build: { write: false, sourcemap: false },
  })
  const chunks = bundleOutputs(result).filter((entry) => entry.type === 'chunk')
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]))
  const publicFacades = ['HostPage.tsx', 'BookingPage.tsx', 'ManageBookingPage.tsx', 'Embed.tsx']
  const entries = chunks.filter((chunk) => chunk.facadeModuleId?.endsWith('/apps/web/index.html'))
  expect(entries.length).toBeGreaterThan(0)
  for (const facade of publicFacades) {
    const chunk = chunks.find((entry) =>
      entry.facadeModuleId?.endsWith(`/apps/web/src/public/${facade}`),
    )
    expect(chunk, `Missing public entry ${facade}`).toBeDefined()
    if (chunk) entries.push(chunk)
  }

  const privateModule =
    /\/apps\/web\/src\/(?:session\.tsx|components\/AppShell\.tsx|i18n\/(?:admin\.ts|catalogues\/[^/]+\/admin\.ts))$/
  const staticChunks = new Set<string>()
  for (const entry of entries) {
    const visited = new Set<string>()
    const pending = [entry.fileName]
    const privateModules = new Set<string>()
    while (pending.length) {
      const fileName = pending.pop()
      if (!fileName || visited.has(fileName)) continue
      visited.add(fileName)
      staticChunks.add(fileName)
      const chunk = byName.get(fileName)
      expect(chunk, `Missing static dependency ${fileName}`).toBeDefined()
      if (!chunk) continue
      for (const id of Object.keys(chunk.modules)) {
        const path = id.split('?', 1)[0] ?? ''
        if (privateModule.test(path) || nonEnglishCatalogue.test(id)) privateModules.add(id)
      }
      pending.push(...chunk.imports)
    }
    expect([...privateModules], `Private modules imported by ${entry.fileName}`).toEqual([])
  }

  const staticCode = chunks
    .filter((chunk) => staticChunks.has(chunk.fileName))
    .map((chunk) => chunk.code)
    .join('\n')
  expect(staticCode).toContain('Pick a time')
  for (const group of ['common', 'admin'] as const) {
    for (const locale of interfaceLanguages('public')) {
      if (locale === 'en') continue
      const catalogue = `/i18n/catalogues/${locale}/${group}.ts`
      const owners = chunks.filter((chunk) =>
        Object.keys(chunk.modules).some((path) => path.endsWith(catalogue)),
      )
      expect(owners.map((chunk) => chunk.fileName)).toEqual([
        expect.stringMatching(new RegExp(`^assets/locales/${locale}-${group}-[\\w-]+\\.js$`)),
      ])
      const [owner] = owners
      if (!owner) throw new Error(`Missing emitted catalogue ${catalogue}`)
      expect(staticChunks.has(owner.fileName)).toBe(false)
      expect(isShellAsset(`/${owner.fileName}`)).toBe(false)
      expect(owner.imports).toEqual([])
      expect(chunks.filter((chunk) => chunk.imports.includes(owner.fileName))).toEqual([])
      expect(Object.keys(owner.modules).filter((path) => nonEnglishCatalogue.test(path))).toEqual([
        expect.stringContaining(catalogue),
      ])
      if (group === 'common') {
        const marker = common[`.${catalogue}`]?.['Pick a time']
        expect(marker).toBeTruthy()
        expect(owner.code).toContain(marker)
        expect(staticCode).not.toContain(marker)
      }
    }
  }
}, 30_000)

it('emits the widget translations as individually loadable classic scripts', async () => {
  const result = await build({
    root: resolve('apps/web'),
    configFile: resolve('apps/web/vite.embed.config.ts'),
    logLevel: 'silent',
    build: { write: false },
  })
  const output = bundleOutputs(result)
  const entry = output.find((file) => file.fileName === 'hourmere-embed.js')
  expect(entry?.type).toBe('chunk')
  if (entry?.type !== 'chunk') throw new Error('Missing widget entry')
  expect(Object.keys(entry.modules).filter((id) => nonEnglishCatalogue.test(id))).toEqual([])
  expect(entry.code).toContain(widget['./i18n/catalogues/en/widget.ts']?.failure)
  for (const locale of interfaceLanguages('public')) {
    if (locale === 'en') continue
    const messages = widget[`./i18n/catalogues/${locale}/widget.ts`]
    if (!messages?.failure) throw new Error(`Missing widget messages for ${locale}`)
    expect(entry.code).not.toContain(messages.failure)
    const catalogue = output.find((file) => file.fileName === `hourmere-embed-locale-${locale}.js`)
    expect(catalogue?.type).toBe('asset')
    if (catalogue?.type !== 'asset') throw new Error(`Missing widget catalogue ${locale}`)
    expect(
      runInNewContext(String(catalogue.source), {
        document: { currentScript: { hourmereMessages: (loaded: Catalog) => loaded } },
      }),
    ).toEqual(messages)
  }
})
