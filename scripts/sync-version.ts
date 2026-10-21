import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface VersionedManifest {
  version: string
  [key: string]: unknown
}

/** npm's root version lifecycle keeps checked-in release metadata in step. */
export function syncVersions(root = process.cwd()) {
  const read = (path: string) =>
    JSON.parse(readFileSync(join(root, path), 'utf8')) as VersionedManifest
  const { version } = read('package.json')
  const cli = read('tools/cli/package.json')
  const lock = read('package-lock.json') as VersionedManifest & {
    packages: { '': VersionedManifest; 'tools/cli': VersionedManifest }
  }
  const registry = read('server.json')

  cli.version = version
  lock.version = version
  lock.packages[''].version = version
  lock.packages['tools/cli'].version = version
  registry.version = version

  for (const [path, manifest] of [
    ['tools/cli/package.json', cli],
    ['package-lock.json', lock],
    ['server.json', registry],
  ] as const) {
    writeFileSync(join(root, path), `${JSON.stringify(manifest, null, 2)}\n`)
  }
}

if (import.meta.main) syncVersions()
