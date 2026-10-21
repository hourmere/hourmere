import assert from 'node:assert/strict'
import { posix } from 'node:path'

export const PACK_FILES = [
  'LICENSE',
  'README.md',
  'dist/cli.js',
  'dist/client.js',
  'dist/index.js',
  'package.json',
] as const

export function assertPackFiles(files: readonly string[]) {
  assert.deepEqual(
    [...files].sort(),
    [...PACK_FILES],
    'CLI tarball must match the exact allow-list',
  )
}

export function assertPackedScripts(
  manifest: { scripts?: Record<string, string> },
  files: readonly string[],
) {
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    // Only a plain Node entrypoint and an optional --version operand are supported.
    // Reject other shell syntax rather than overlook a hidden path or Node option.
    const args = command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []
    assert.ok(
      args[0] === 'node' && (args.length === 2 || (args.length === 3 && args[2] === '--version')),
      `Packed CLI script ${name} must use node <packed-file>`,
    )
    const path = (args[1] ?? '').replace(/^(['"])(.*)\1$/, '$2')
    assert.ok(
      files.includes(posix.normalize(path)),
      `Packed CLI script ${name} references a missing tarball path: ${path}`,
    )
  }
}

export function assertPackage(manifest: {
  name?: string
  version?: string
  private?: boolean
  type?: string
  bin?: unknown
  dependencies?: unknown
  optionalDependencies?: unknown
  peerDependencies?: unknown
}) {
  assert.equal(manifest.name, '@hourmere/cli')
  assert.match(manifest.version ?? '', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  assert.notEqual(manifest.private, true)
  assert.equal(manifest.type, 'module')
  assert.deepEqual(manifest.bin, { hourmere: 'dist/index.js' }, 'CLI bin must use compiled JS')
  assert.deepEqual(
    [
      manifest.dependencies ?? {},
      manifest.optionalDependencies ?? {},
      manifest.peerDependencies ?? {},
    ],
    [{}, {}, {}],
    'CLI must not require workspace or registry dependencies at runtime',
  )
}

export function assertCliOutput(help: string, version: string, expectedVersion: string) {
  assert.match(help, /^Usage: hourmere COMMAND/m, 'Packed CLI help must use the installed command')
  assert.match(help, /Commands: whoami/)
  assert.equal(version, `${expectedVersion}\n`, 'Packed CLI version must match package metadata')
}
