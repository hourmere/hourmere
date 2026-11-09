import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  assertStorageInterfacesUnchanged,
  INTERFACE_SURFACES,
  type StorageInterfaceSnapshot,
  storageInterfaceSnapshot,
} from './storage-interface-snapshot.ts'

const baselinePath = process.env.STORAGE_INTERFACE_BASELINE

describe('storage-only interface gate', () => {
  it.skipIf(!baselinePath)(
    'keeps all four surfaces byte-identical to the supplied main snapshot',
    async () => {
      const baseline = JSON.parse(readFileSync(baselinePath as string, 'utf8'))
      assertStorageInterfacesUnchanged(baseline, await storageInterfaceSnapshot())
    },
  )

  it('produces complete, deterministic interface bytes without connecting to a database', async () => {
    const first = await storageInterfaceSnapshot()
    for (const surface of INTERFACE_SURFACES) expect(first[surface].length).toBeGreaterThan(0)
    assertStorageInterfacesUnchanged(first, await storageInterfaceSnapshot())
  })

  it.each(INTERFACE_SURFACES)('rejects source-copy changes to %s', async (surface) => {
    const source = await storageInterfaceSnapshot()
    const changed = { ...source, [surface]: `${source[surface]} ` }
    expect(() => assertStorageInterfacesUnchanged(source, changed)).toThrow(
      `Storage-only change altered ${surface}`,
    )
    const missing = { ...source }
    delete (missing as Partial<StorageInterfaceSnapshot>)[surface]
    expect(() => assertStorageInterfacesUnchanged(missing, source)).toThrow(
      `Missing baseline: ${surface}`,
    )
    assertStorageInterfacesUnchanged(source, source)
  })

  it('detects source-copy removal of the byte comparison', async () => {
    const source = readFileSync(new URL('./storage-interface-snapshot.ts', import.meta.url), 'utf8')
    const start = source.indexOf('export function assertStorageInterfacesUnchanged(')
    const end = source.indexOf('\nif (import.meta.main)')
    const guard =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source-copy mutation anchor
      'assert.equal(current[surface], baseline[surface], `Storage-only change altered ${surface}`)'
    const body = source.slice(start, end).replace('export function', 'function')
    expect(body).toContain(guard)
    const changed = stripTypeScriptTypes(body.replace(guard, ''))
    const mutant = new Function(
      'assert',
      'INTERFACE_SURFACES',
      `${changed}; return assertStorageInterfacesUnchanged`,
    )(assert, INTERFACE_SURFACES) as typeof assertStorageInterfacesUnchanged
    const snapshot = await storageInterfaceSnapshot()
    for (const surface of INTERFACE_SURFACES) {
      const altered = { ...snapshot, [surface]: `${snapshot[surface]} ` }
      expect(() => {
        expect(() => mutant(snapshot, altered)).toThrow()
      }).toThrow()
      expect(() => assertStorageInterfacesUnchanged(snapshot, altered)).toThrow()
    }
  })

  it('detects source-copy removal of baseline completeness checking', async () => {
    const source = readFileSync(new URL('./storage-interface-snapshot.ts', import.meta.url), 'utf8')
    const body = source
      .slice(
        source.indexOf('export function assertStorageInterfacesUnchanged('),
        source.indexOf('\nif (import.meta.main)'),
      )
      .replace('export function', 'function')
    const guard =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source-copy mutation anchor
      "assert.equal(typeof baseline[surface], 'string', `Missing baseline: ${surface}`)"
    expect(body).toContain(guard)
    const mutant = new Function(
      'assert',
      'INTERFACE_SURFACES',
      `${stripTypeScriptTypes(body.replace(guard, ''))}; return assertStorageInterfacesUnchanged`,
    )(assert, INTERFACE_SURFACES) as typeof assertStorageInterfacesUnchanged
    const snapshot = await storageInterfaceSnapshot()
    for (const surface of INTERFACE_SURFACES) {
      const missing = { ...snapshot }
      delete (missing as Partial<StorageInterfaceSnapshot>)[surface]
      expect(() => {
        expect(() => mutant(missing, missing)).toThrow()
      }).toThrow()
      expect(() => assertStorageInterfacesUnchanged(missing, missing)).toThrow()
    }
  })
})
