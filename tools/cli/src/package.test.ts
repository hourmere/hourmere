import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  assertCliOutput,
  assertPackage,
  assertPackFiles,
  PACK_FILES,
} from '../scripts/pack-check.ts'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

describe('CLI npm packaging protections', () => {
  it('prepares a public dependency-free ESM executable with a release version', () => {
    expect(() => assertPackage(manifest)).not.toThrow()
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(manifest.license).toBe('AGPL-3.0-only')
    expect(manifest.scripts.prepack).toBe('npm run build')
    expect(manifest.files).toEqual([
      'dist/index.js',
      'dist/cli.js',
      'dist/client.js',
      'README.md',
      'LICENSE',
    ])
  })

  it('refuses extra tarball files even when they look like harmless source files', () => {
    expect(() => assertPackFiles([...PACK_FILES, 'src/cli.test.ts'])).toThrow(/exact allow-list/)
  })

  it('refuses tarballs missing a runtime file', () => {
    expect(() => assertPackFiles(PACK_FILES.filter((file) => file !== 'dist/client.js'))).toThrow(
      /exact allow-list/,
    )
  })

  it('accepts exactly the six expected files in any order', () => {
    expect(() => assertPackFiles([...PACK_FILES].reverse())).not.toThrow()
  })

  it.each([
    { field: 'name', value: '@somebody/cli' },
    { field: 'version', value: 'next' },
    { field: 'private', value: true },
    { field: 'type', value: 'commonjs' },
  ])('refuses incorrect $field metadata', ({ field, value }) => {
    expect(() => assertPackage({ ...manifest, [field]: value })).toThrow()
  })

  it('refuses a source TypeScript bin that Node cannot execute from node_modules', () => {
    expect(() => assertPackage({ ...manifest, bin: { hourmere: 'src/index.ts' } })).toThrow(
      /compiled JS/,
    )
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'])(
    'refuses runtime %s that could resolve only inside the workspace',
    (field) => {
      expect(() => assertPackage({ ...manifest, [field]: { '@hourmere/core': '*' } })).toThrow(
        /runtime/,
      )
    },
  )

  it('checks the executable help instead of accepting an empty successful invocation', () => {
    expect(() => assertCliOutput('', `${manifest.version}\n`, manifest.version)).toThrow(
      /installed command/,
    )
  })

  it('requires the help to include commands', () => {
    expect(() =>
      assertCliOutput('Usage: hourmere COMMAND\n', `${manifest.version}\n`, manifest.version),
    ).toThrow()
  })

  it('refuses a hard-coded version that disagrees with release metadata', () => {
    expect(() =>
      assertCliOutput('Usage: hourmere COMMAND\nCommands: whoami\n', '0.0.0\n', '1.0.0'),
    ).toThrow(/match package metadata/)
  })
})
