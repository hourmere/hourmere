import { chmod, mkdtemp, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SourceSnapshot } from './types.ts'

vi.mock('./source.ts', () => ({ extractSource: vi.fn() }))
vi.mock('./operator-cli.ts', () => ({ runDatabaseCli: vi.fn() }))

import {
  operatorMessages,
  readProtectedFile,
  runParseCli as runCli,
  runCli as runEntryCli,
} from './cli.ts'
import { checkSourceMutation, required } from './mutation-testing.ts'
import { runDatabaseCli } from './operator-cli.ts'
import { SourceRefusal } from './schema.ts'
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
    expect(output).toEqual([`[IMPORT_REFUSED] ${operatorMessages.en.refused}`])
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
    expect(output[1]).toBe(`[IMPORT_REFUSED] ${operatorMessages['zh-CN'].refused}`)
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
    (m) => m.runParseCli as typeof runCli,
    async (run) => {
      const output: string[] = []
      expect(await run(['--config', input], {}, (text) => output.push(text))).toBe(1)
      expect(output).toEqual([`[IMPORT_REFUSED] ${operatorMessages.en.refused}`])
    },
  )
})

const refusalCases = [
  ['SOURCE_LIMIT_EXCEEDED', 'refused'],
  ['SOURCE_CONNECTION_INVALID', 'refused'],
  ['SOURCE_EXTRACTION_FAILED', 'refused'],
  ['SOURCE_PAYMENT_SHAPE_UNKNOWN', 'refused'],
  ['SOURCE_SCHEMA_UNKNOWN', 'schema'],
  ['SOURCE_VERSION_UNKNOWN', 'schema'],
  ['SOURCE_TIMEZONE_NOT_UTC', 'timezone'],
  ['SOURCE_UTC_UNCONFIRMED', 'timezone'],
  ['SOURCE_ROLE_UNSAFE', 'role'],
  ['SOURCE_ISOLATION_UNSAFE', 'refused'],
  ['SOURCE_NOT_READ_ONLY', 'refused'],
  ['SOURCE_SELECTION_INVALID', 'refused'],
] as const

it.each(refusalCases)(
  'prints the stable %s refusal code without driver details',
  async (code, message) => {
    const path = await protectedFile(JSON.stringify(config()))
    vi.mocked(extractSource).mockRejectedValue(new SourceRefusal(code, 'driver-private-secret'))
    for (const lang of ['en', 'zh-CN'] as const) {
      const output: string[] = []
      expect(
        await runCli(
          ['--config', path, '--lang', lang],
          { CALCOM_IMPORT_SOURCE_URL: 'private-dsn-secret' },
          (text) => output.push(text),
        ),
      ).toBe(1)
      expect(output).toEqual([`[${code}] ${operatorMessages[lang][message]}`])
      expect(output.join()).not.toMatch(/private|secret|input.json/)
    }
  },
)

it('does not print an unrecognized refusal code or its message', async () => {
  const path = await protectedFile(JSON.stringify(config()))
  vi.mocked(extractSource).mockRejectedValue(
    new SourceRefusal('postgres://private:secret@example.com', 'private-driver-secret'),
  )
  const output: string[] = []
  expect(
    await runCli(['--config', path], { CALCOM_IMPORT_SOURCE_URL: 'private-dsn-secret' }, (text) =>
      output.push(text),
    ),
  ).toBe(1)
  expect(output).toEqual([`[IMPORT_REFUSED] ${operatorMessages.en.refused}`])
})

it('kills source-copy refusal-code omission and arbitrary-code output mutations', async () => {
  const source = new URL('./cli.ts', import.meta.url)
  const path = await protectedFile(JSON.stringify(config()))
  const check = async (run: typeof runCli) => {
    const output: string[] = []
    expect(
      await run(['--config', path], { CALCOM_IMPORT_SOURCE_URL: 'private-dsn-secret' }, (text) =>
        output.push(text),
      ),
    ).toBe(1)
    return output
  }
  vi.mocked(extractSource).mockRejectedValue(
    new SourceRefusal('SOURCE_LIMIT_EXCEEDED', 'private-driver-secret'),
  )
  await checkSourceMutation(
    source,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-copy mutation target
    '`[${code}] ${',
    '`${',
    (m) => m.runParseCli as typeof runCli,
    async (run) => {
      expect(await check(run)).toEqual([`[SOURCE_LIMIT_EXCEEDED] ${operatorMessages.en.refused}`])
    },
  )
  vi.mocked(extractSource).mockRejectedValue(
    new SourceRefusal('private-secret-code', 'private-driver-secret'),
  )
  await checkSourceMutation(
    source,
    'error instanceof SourceRefusal && refusalCodes.has(error.code)',
    'error instanceof SourceRefusal',
    (m) => m.runParseCli as typeof runCli,
    async (run) => {
      expect(await check(run)).toEqual([`[IMPORT_REFUSED] ${operatorMessages.en.refused}`])
    },
  )
})

describe('CLI subcommand dispatch', () => {
  it.each(['preview', 'apply', 'register-source'])(
    'dispatches explicit %s to the database CLI',
    async (command) => {
      const argv = [command, '--config', '/private/config.json']
      const env = {}
      const write = vi.fn()
      vi.mocked(runDatabaseCli).mockResolvedValue(2)
      expect(await runEntryCli(argv, env, write)).toBe(2)
      expect(runDatabaseCli).toHaveBeenCalledWith(argv, env, write)
    },
  )

  it('preserves legacy dry-run arguments and the explicit parse alias', async () => {
    const path = await protectedFile(JSON.stringify(config()))
    vi.mocked(extractSource).mockResolvedValue(snapshot)
    for (const prefix of [[], ['parse']]) {
      const output: string[] = []
      expect(
        await runEntryCli(
          [...prefix, '--config', path],
          { CALCOM_IMPORT_SOURCE_URL: 'private-dsn-secret' },
          (s) => output.push(s),
        ),
      ).toBe(2)
      expect(output[0]).toBe(operatorMessages.en.complete)
    }
    expect(runDatabaseCli).not.toHaveBeenCalled()
  })

  it.each([[], ['unknown'], ['--unknown'], ['--config', 'missing', '--out', 'report']])(
    'refuses unsupported arguments %j without dispatching to the database CLI',
    async (...args) => {
      const argv = args as string[]
      const output: string[] = []
      expect(await runEntryCli(argv, {}, (s) => output.push(s))).toBe(1)
      expect(output).toEqual([`[IMPORT_REFUSED] ${operatorMessages.en.refused}`])
      expect(runDatabaseCli).not.toHaveBeenCalled()
    },
  )

  it('preserves legacy help and kills broad database dispatch', async () => {
    const check = async (run: typeof runEntryCli) => {
      const output: string[] = []
      expect(await run(['--help'], {}, (s) => output.push(s))).toBe(0)
      expect(output).toEqual([operatorMessages.en.help])
      expect(runDatabaseCli).not.toHaveBeenCalled()
    }
    await check(runEntryCli)
    await checkSourceMutation(
      new URL('./cli.ts', import.meta.url),
      "if (['preview', 'apply', 'register-source'].includes(argv[0] ?? ''))",
      'if (true)',
      (m) => m.runCli as typeof runEntryCli,
      check,
    )
  })
})
