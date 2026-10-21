import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { deploymentPasteSkipReason, pasteIntoZshPty } from './deploy-docs-pty.ts'

const directories: string[] = []
function toolPath(missing: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'hourmere-paste-tools-'))
  directories.push(directory)
  for (const tool of ['zsh', 'python3']) {
    if (missing.includes(tool)) continue
    writeFileSync(
      join(directory, tool),
      `#!/bin/sh\nprintf '%s\\n' '${tool}' >> '${join(directory, 'probes')}'\n`,
      { mode: 0o755 },
    )
  }
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true })
})

describe('deployment paste tool prerequisites', () => {
  it.each(['', 'true', '1'])('probes each available tool once (CI=%s)', (CI) => {
    const PATH = toolPath([])
    expect(deploymentPasteSkipReason({ PATH, CI })).toBeUndefined()
    expect(readFileSync(join(PATH, 'probes'), 'utf8')).toBe('zsh\npython3\n')
  })

  it.each([{ missing: ['zsh'] }, { missing: ['python3'] }, { missing: ['zsh', 'python3'] }])(
    'names missing tools in the local skip reason ($missing)',
    ({ missing }) => {
      const reason = deploymentPasteSkipReason({ PATH: toolPath(missing), CI: '' })
      expect(reason).toBe(`Missing ${missing.join(' and ')} on PATH for the deployment paste tests`)
    },
  )

  it.each([
    { missing: ['zsh'], CI: 'true' },
    { missing: ['python3'], CI: 'true' },
    { missing: ['zsh', 'python3'], CI: 'true' },
    { missing: ['zsh'], CI: '1' },
    { missing: ['python3'], CI: 'false' },
  ])('fails fast in CI when $missing is missing (CI=$CI)', ({ missing, CI }) => {
    expect(() => deploymentPasteSkipReason({ PATH: toolPath(missing), CI })).toThrow(
      `CI must install zsh and python3 for the deployment paste tests. Missing ${missing.join(' and ')} on PATH`,
    )
  })

  it('preserves ENOENT when python3 disappears after the probe', () => {
    const directory = toolPath(['python3'])
    const result = pasteIntoZshPty('exit 0\n', directory, { PATH: directory })
    expect(result.status).toBeNull()
    expect(result.stderr).toContain('spawnSync python3 ENOENT')
  })

  it('preserves a spawn error alongside stderr', () => {
    const directory = toolPath(['python3'])
    writeFileSync(
      join(directory, 'python3'),
      '#!/bin/sh\nprintf "synthetic PTY failure" >&2\nwhile :; do :; done\n',
      { mode: 0o755 },
    )
    const result = pasteIntoZshPty('exit 0\n', directory, { PATH: directory })
    expect(result.stderr).toContain('synthetic PTY failure')
    expect(result.stderr).toContain('ETIMEDOUT')
  })
})

describe('deployment paste skip wiring', () => {
  it.each([
    { missing: 'zsh', CI: '' },
    { missing: 'python3', CI: '' },
    { missing: 'zsh', CI: 'true' },
    { missing: 'python3', CI: 'true' },
  ])('runs the deployment file without $missing (CI=$CI)', ({ missing, CI }) => {
    const directory = toolPath([missing])
    const root = fileURLToPath(new URL('../', import.meta.url))
    const report = join(directory, 'report.json')
    const config = join(directory, 'vitest.config.mjs')
    writeFileSync(
      config,
      `export default ${JSON.stringify({
        test: {
          include: ['scripts/deploy-docs.test.ts'],
          reporters: ['json', 'verbose'],
          outputFile: { json: report },
        },
      })}`,
    )
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        config,
        '--maxWorkers=2',
        '-t',
        'zsh PTY paste|pastes a plain-mode',
      ],
      {
        cwd: root,
        env: { ...process.env, PATH: directory, CI },
        encoding: 'utf8',
        timeout: 15000,
      },
    )
    const output = [result.stdout, result.stderr, result.error?.message].join('\n')
    expect(result.error, output).toBeUndefined()
    expect(result.status, output).toBe(CI ? 1 : 0)
    if (CI) {
      expect(output).toContain('CI must install zsh and python3 for the deployment paste tests')
    } else {
      const json = JSON.parse(readFileSync(report, 'utf8')) as {
        testResults: { assertionResults: { fullName: string; status: string }[] }[]
      }
      const ptyTests = json.testResults
        .flatMap((suite) => suite.assertionResults)
        .filter((test) => /zsh PTY paste|pastes a plain-mode/.test(test.fullName))
      expect(ptyTests).toHaveLength(28)
      expect(
        ptyTests.every((test) => test.status === 'skipped'),
        output,
      ).toBe(true)
      expect(output).toContain(`Missing ${missing} on PATH for the deployment paste tests`)
    }
  })
})
