// @vitest-environment node
import { resolve } from 'node:path'
import { build } from 'vite'
import { expect, it } from 'vitest'

it('keeps session and admin modules outside the public production chunk graph', async () => {
  const result = await build({
    root: resolve('apps/web'),
    configFile: resolve('apps/web/vite.config.ts'),
    publicDir: false,
    logLevel: 'silent',
    build: { write: false, sourcemap: false },
  })
  const bundles = Array.isArray(result) ? result : [result]
  const chunks = bundles.flatMap((bundle) => {
    if (!('output' in bundle)) throw new Error('Unexpected watch build')
    return bundle.output.filter((entry) => entry.type === 'chunk')
  })
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]))
  const publicFacades = ['HostPage.tsx', 'BookingPage.tsx', 'ManageBookingPage.tsx', 'Embed.tsx']
  const entries = chunks.filter((chunk) => chunk.isEntry)
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
  for (const entry of entries) {
    const visited = new Set<string>()
    const pending = [entry.fileName]
    const privateModules = new Set<string>()
    while (pending.length) {
      const fileName = pending.pop()
      if (!fileName || visited.has(fileName)) continue
      visited.add(fileName)
      const chunk = byName.get(fileName)
      expect(chunk, `Missing static dependency ${fileName}`).toBeDefined()
      if (!chunk) continue
      for (const id of Object.keys(chunk.modules)) {
        if (privateModule.test(id.split('?', 1)[0] ?? '')) privateModules.add(id)
      }
      pending.push(...chunk.imports)
    }
    expect([...privateModules], `Private modules imported by ${entry.fileName}`).toEqual([])
  }
}, 30_000)
