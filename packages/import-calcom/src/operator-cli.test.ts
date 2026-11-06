import { mkdtemp, readFile, rmdir, stat, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { checkSourceMutation } from './mutation-testing.ts'
import { operatorRefusalCode, writeProtectedOutput } from './operator-cli.ts'
import { SourceRefusal } from './schema.ts'
import { TargetRefusal } from './target.ts'

const directories: string[] = [],
  files: string[] = []
afterEach(async () => {
  for (const file of files.splice(0)) await unlink(file).catch(() => {})
  for (const dir of directories.splice(0)) await rmdir(dir)
})
async function path() {
  const dir = await mkdtemp(join(tmpdir(), 'calcom-report-'))
  directories.push(dir)
  const file = join(dir, 'report')
  files.push(file)
  return file
}
it('writes private reports exclusively and never overwrites or follows a symlink', async () => {
  const file = await path()
  await writeProtectedOutput(file, 'private report')
  expect((await stat(file)).mode & 0o077).toBe(0)
  await expect(writeProtectedOutput(file, 'replacement')).rejects.toThrow()
  expect(await readFile(file, 'utf8')).toBe('private report')
  const link = await path()
  await symlink(file, link)
  await expect(writeProtectedOutput(link, 'replacement')).rejects.toThrow()
})
it('only returns allowlisted static refusal codes, never arbitrary driver or source text', () => {
  expect(operatorRefusalCode(new SourceRefusal('SOURCE_LIMIT_EXCEEDED', 'private source'))).toBe(
    'SOURCE_LIMIT_EXCEEDED',
  )
  expect(operatorRefusalCode(new TargetRefusal('IMPORT_TARGET_LIMIT'))).toBe('IMPORT_TARGET_LIMIT')
  expect(operatorRefusalCode(new SourceRefusal('SOURCE_PRIVATE_SECRET', 'private source'))).toBe(
    'IMPORT_REFUSED',
  )
  expect(
    operatorRefusalCode(Object.assign(new Error('private driver'), { code: 'postgres://private' })),
  ).toBe('IMPORT_REFUSED')
})
it('source-copy controls protect report permissions, exclusive creation and static refusal codes', async () => {
  const source = new URL('./operator-cli.ts', import.meta.url)
  await checkSourceMutation(
    source,
    '0o600',
    '0o644',
    (m) => m.writeProtectedOutput as typeof writeProtectedOutput,
    async (write) => {
      const file = await path()
      await write(file, 'private')
      expect((await stat(file)).mode & 0o077).toBe(0)
    },
  )
  const file = await path()
  await writeProtectedOutput(file, 'kept')
  await checkSourceMutation(
    source,
    'constants.O_EXCL',
    '0',
    (m) => m.writeProtectedOutput as typeof writeProtectedOutput,
    async (write) => {
      await expect(write(file, 'changed')).rejects.toThrow()
    },
  )
  await checkSourceMutation(
    source,
    'operatorCodes.has(code)',
    'true',
    (m) => m.operatorRefusalCode as typeof operatorRefusalCode,
    (safe) => {
      expect(safe(new SourceRefusal('SOURCE_PRIVATE_SECRET', 'private'))).toBe('IMPORT_REFUSED')
    },
  )
})
