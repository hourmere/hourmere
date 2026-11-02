import { chmod, mkdtemp, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SourceSnapshot } from './types.ts'

vi.mock('./source.ts', () => ({ extractSource: vi.fn() }))

import { operatorMessages, readProtectedFile, runCli } from './cli.ts'
import { checkSourceMutation, required } from './mutation-testing.ts'
import { extractSource } from './source.ts'

const files: string[] = []
const directories: string[] = []
afterEach(async () => {
  vi.resetAllMocks()
  for (const path of files.splice(0)) await unlink(path)
  for (const path of directories.splice(0)) await rmdir(path)
})
async function protectedFile(text: string, mode = 0o600) {
  const dir = await mkdtemp(join(tmpdir(), 'hourmere-calcom-cli-'))
  directories.push(dir)
  const path = join(dir, 'input.json')
  await writeFile(path, text, { mode })
  files.push(path)
  return path
}
const config = () => ({
  sourceVersion: 'cal.diy-a5ee96f77edd',
  selectedUserIds: [1],
  utcTimestampsConfirmed: true,
  target: { users: [], occupiedHandles: [], occupiedSlugs: [], busy: [] },
  bookingDecisions: [],
})
const snapshot: SourceSnapshot = {
  sourceVersion: 'cal.diy-a5ee96f77edd',
  selectedUserIds: [1],
  schemaFingerprint: 'a'.repeat(64),
  extractedAt: '2026-11-01T00:00:00.000Z',
  cutoff: '2026-11-01T00:00:00.000Z',
  tables: { users: [] },
}
describe('operator dry run and secret handling', () => {
  it('reads only bounded owner-private regular files and rejects symlinks', async () => {
    const path = await protectedFile('hello')
    expect(await readProtectedFile(path, 5)).toBe('hello')
    await expect(readProtectedFile(path, 4)).rejects.toThrow()
    await chmod(path, 0o644)
    await expect(readProtectedFile(path, 10)).rejects.toThrow()
    await chmod(path, 0o600)
    const link = join(required(directories[0]), 'link')
    await symlink(path, link)
    files.push(link)
    await expect(readProtectedFile(link, 10)).rejects.toThrow()
  })
  it('prints summary and problems without serializing private plan data', async () => {
    const path = await protectedFile(JSON.stringify(config()))
    const output: string[] = []
    vi.mocked(extractSource).mockResolvedValue(snapshot)
    expect(
      await runCli(
        ['--config', path],
        { CALCOM_IMPORT_SOURCE_URL: 'postgres://reader:secret@localhost/source' },
        (s) => output.push(s),
      ),
    ).toBe(2)
    expect(output.join('\n')).toContain('Nothing was imported')
    expect(output.join('\n')).toContain('user_missing')
    expect(output.join('\n')).not.toContain('secret')
    expect(extractSource).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedUserIds: [1],
        utcTimestampsConfirmed: true,
        targetUsers: [],
      }),
    )
  })
  it('redacts driver errors, paths, URLs and nested causes', async () => {
    const path = await protectedFile(JSON.stringify(config()))
    const output: string[] = []
    vi.mocked(extractSource).mockRejectedValue(
      new Error('postgres://reader:driver-secret@localhost/source', {
        cause: new Error('private@example.com'),
      }),
    )
    expect(
      await runCli(
        ['--config', path],
        { CALCOM_IMPORT_SOURCE_URL: 'postgres://reader:env-secret@localhost/source' },
        (s) => output.push(s),
      ),
    ).toBe(1)
    expect(output).toEqual([operatorMessages.en.refused])
    expect(output.join()).not.toMatch(/secret|private@example|input.json/)
  })
  it('supports a protected connection file and refuses conflicting inputs', async () => {
    const connection = await protectedFile('postgres://reader:file-secret@localhost/source\n')
    const path = await protectedFile(
      JSON.stringify({ ...config(), sourceConnectionFile: connection }),
    )
    vi.mocked(extractSource).mockResolvedValue(snapshot)
    expect(await runCli(['--config', path], {}, () => {})).toBe(2)
    expect(extractSource).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgres://reader:file-secret@localhost/source',
      }),
    )
    vi.mocked(extractSource).mockClear()
    expect(await runCli(['--config', path], { CALCOM_IMPORT_SOURCE_URL: 'secret' }, () => {})).toBe(
      1,
    )
    expect(extractSource).not.toHaveBeenCalled()
  })
  it('refuses credentials in arguments, unsafe configuration and wrong UTC attestation', async () => {
    const output: string[] = []
    expect(
      await runCli(['--source-url', 'postgres://reader:argv-secret@localhost/source'], {}, (s) =>
        output.push(s),
      ),
    ).toBe(1)
    const path = await protectedFile(JSON.stringify({ ...config(), utcTimestampsConfirmed: false }))
    expect(
      await runCli(['--config', path], { CALCOM_IMPORT_SOURCE_URL: 'secret' }, (s) =>
        output.push(s),
      ),
    ).toBe(1)
    expect(extractSource).not.toHaveBeenCalled()
    expect(output.join()).not.toContain('argv-secret')
  })
  it('provides English and Simplified Chinese operator messages', async () => {
    const output: string[] = []
    expect(await runCli(['--help'], {}, (s) => output.push(s))).toBe(0)
    expect(
      await runCli(['--config', 'missing', '--lang', 'zh-CN'], {}, (s) => output.push(s)),
    ).toBe(1)
    expect(output[1]).toBe(operatorMessages['zh-CN'].refused)
  })
})

it('kills source-copy private-file permission, symlink and error-output mutations', async () => {
  const source = new URL('./cli.ts', import.meta.url)
  const input = await protectedFile('private-secret', 0o644)
  await checkSourceMutation(
    source,
    'stat.mode & 0o077',
    '0',
    (m) => m.readProtectedFile as typeof readProtectedFile,
    async (run) => {
      await expect(run(input, 100)).rejects.toThrow()
    },
  )
  await chmod(input, 0o600)
  const link = join(required(directories[0]), 'link')
  await symlink(input, link)
  files.push(link)
  await checkSourceMutation(
    source,
    'constants.O_RDONLY | constants.O_NOFOLLOW',
    'constants.O_RDONLY',
    (m) => m.readProtectedFile as typeof readProtectedFile,
    async (run) => {
      await expect(run(link, 100)).rejects.toThrow()
    },
  )
  await checkSourceMutation(
    source,
    'catch (error) {\n    // Do not forward',
    'catch (error) { write(String(error));\n    // Do not forward',
    (m) => m.runCli as typeof runCli,
    async (run) => {
      const output: string[] = []
      expect(await run(['--config', input], {}, (text) => output.push(text))).toBe(1)
      expect(output).toEqual([operatorMessages.en.refused])
    },
  )
})
