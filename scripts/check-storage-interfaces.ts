// Compare storage-only changes with the event base, using an isolated source archive.
// Later interface work does not inherit a permanently frozen product snapshot.
import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import {
  assertStorageInterfacesUnchanged,
  storageInterfaceSnapshot,
} from './storage-interface-snapshot.ts'

export const STORAGE_MIGRATION = 'packages/db/migrations/0072_routing_forms.sql'

const root = resolve(import.meta.dirname, '..')
const repositoryGit = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

const SAME_AS_HEAD = 'Storage interface baseline must differ from HEAD'

// A misspelled path would make the comparison permanently "not applicable".
export function assertStorageMigrationExists(migration = STORAGE_MIGRATION) {
  if (!existsSync(join(root, migration)))
    throw new Error(`Storage migration ${migration} does not exist`)
}

// The baseline must be the merge-base commit itself: an archive of HEAD (or of a bare
// tree) would compare the current interfaces with themselves and always pass.
export function archiveBaseline(ancestor: string, head: string) {
  const archive = execFileSync('git', ['archive', ancestor], {
    cwd: root,
    maxBuffer: 100 * 1024 * 1024,
  })
  // git archive records the commit in the leading pax header; pass only that header.
  const identity = spawnSync('git', ['get-tar-commit-id'], {
    cwd: root,
    input: archive.subarray(0, 1024),
    encoding: 'utf8',
  })
  const archived = identity.status === 0 ? identity.stdout.trim() : ''
  if (archived === head) throw new Error(SAME_AS_HEAD)
  if (archived !== ancestor)
    throw new Error(
      `Storage interface baseline archive is ${archived || 'not a commit'}, expected ${ancestor}`,
    )
  return archive
}

// Writes the snapshot of `ancestor` to `output`, built inside `directory` from its archive.
export function writeArchivedBaseline(
  ancestor: string,
  head: string,
  directory: string,
  output: string,
) {
  execFileSync('tar', ['-x', '-C', directory], { input: archiveBaseline(ancestor, head) })
  // Third-party dependencies are reused; workspace packages resolve to the archive,
  // never to the current checkout, so baseline runtime source stays independent.
  const modules = join(directory, 'node_modules')
  mkdirSync(modules)
  for (const entry of readdirSync(join(root, 'node_modules'))) {
    if (entry !== '@hourmere') symlinkSync(join(root, 'node_modules', entry), join(modules, entry))
  }
  mkdirSync(join(modules, '@hourmere'))
  for (const group of ['apps', 'packages', 'tools']) {
    for (const name of readdirSync(join(directory, group))) {
      let manifest: { name?: string }
      try {
        manifest = JSON.parse(readFileSync(join(directory, group, name, 'package.json'), 'utf8'))
      } catch {
        continue
      }
      const nestedModules = join(root, group, name, 'node_modules')
      if (existsSync(nestedModules)) {
        const targetModules = join(directory, group, name, 'node_modules')
        mkdirSync(targetModules)
        for (const entry of readdirSync(nestedModules)) {
          symlinkSync(
            entry === '@hourmere' ? join(modules, '@hourmere') : join(nestedModules, entry),
            join(targetModules, entry),
          )
        }
      }
      if (manifest.name?.startsWith('@hourmere/')) {
        const link = join(modules, manifest.name)
        symlinkSync(relative(join(modules, '@hourmere'), join(directory, group, name)), link)
      }
    }
  }
  copyFileSync(
    join(root, 'scripts/storage-interface-snapshot.ts'),
    join(directory, 'scripts/storage-interface-snapshot.ts'),
  )
  execFileSync(
    process.execPath,
    [join(directory, 'scripts/storage-interface-snapshot.ts'), output],
    {
      cwd: directory,
      stdio: 'pipe',
    },
  )
}

export async function checkStorageInterfaces(
  base: string,
  git = repositoryGit,
  { migration = STORAGE_MIGRATION, writeBaseline = writeArchivedBaseline } = {},
) {
  assertStorageMigrationExists(migration)
  const ancestor = git('merge-base', base, 'HEAD')
  const changed = git('diff', '--name-only', ancestor, 'HEAD', '--', migration)
  if (!changed) return false
  const head = git('rev-parse', 'HEAD')
  if (ancestor === head) throw new Error(SAME_AS_HEAD)

  const directory = mkdtempSync(join(tmpdir(), 'hourmere-storage-interfaces-'))
  try {
    const output = join(directory, 'interfaces.json')
    writeBaseline(ancestor, head, directory, output)
    assertStorageInterfacesUnchanged(
      JSON.parse(readFileSync(output, 'utf8')),
      await storageInterfaceSnapshot(),
    )
    return true
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const base = process.argv[2]
  if (!base) throw new Error('Usage: node scripts/check-storage-interfaces.ts BASE_REF')
  console.log(
    (await checkStorageInterfaces(base))
      ? 'Storage-only interfaces match the event merge base.'
      : 'Storage migration unchanged; interface comparison is not applicable.',
  )
}
