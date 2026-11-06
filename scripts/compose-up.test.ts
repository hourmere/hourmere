import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./compose-up.sh', import.meta.url), 'utf8')
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

function verifyFreshDigest(script = source) {
  const directory = mkdtempSync(join(tmpdir(), 'hourmere-compose-up-'))
  try {
    mkdirSync(join(directory, 'scripts'))
    mkdirSync(join(directory, 'bin'))
    writeFileSync(join(directory, 'scripts/compose-up.sh'), script)
    writeFileSync(
      join(directory, 'bin/docker'),
      `#!/bin/sh\nprintf '%s\\n' "$CADDYFILE_SHA256" "$PWD" "$@"\nexit "\${COMPOSE_EXIT:-0}"\n`,
      { mode: 0o755 },
    )
    const run = (status = 0) =>
      spawnSync('/bin/sh', [join(directory, 'scripts/compose-up.sh'), '-d', '--build', '--wait'], {
        cwd: tmpdir(),
        encoding: 'utf8',
        env: {
          PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
          CADDYFILE_SHA256: 'stale-inherited-digest',
          COMPOSE_EXIT: String(status),
        },
      })
    const file = join(directory, 'Caddyfile')
    for (const [index, contents] of [
      'original custom configuration\n',
      'checked-out revision\n',
      'in-place operator edit\n',
      'original custom configuration\n',
    ].entries()) {
      if (index === 1) {
        writeFileSync(join(directory, 'next'), contents)
        renameSync(join(directory, 'next'), file)
      } else writeFileSync(file, contents)
      const result = run()
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim().split('\n')).toEqual([
        sha256(contents),
        directory,
        'compose',
        'up',
        '-d',
        '--build',
        '--wait',
      ])
    }
    expect(run(7).status).toBe(7)
    rmSync(file)
    const missing = run()
    expect(missing.status).not.toBe(0)
    expect(missing.stdout).toBe('')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('Compose start helper', () => {
  it('hashes checked-out and customized content afresh, forwards arguments and propagates failures', () =>
    verifyFreshDigest())

  it('detects stale hashing or a dropped digest export in source copies', () => {
    for (const mutant of [
      source.replace(/CADDYFILE_SHA256=\$\{digest%% \*\}/, `CADDYFILE_SHA256=${'a'.repeat(64)}`),
      source.replace('export CADDYFILE_SHA256', 'unset CADDYFILE_SHA256'),
    ]) {
      expect(mutant).not.toBe(source)
      expect(() => verifyFreshDigest(mutant)).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    }
    verifyFreshDigest()
  })
})
