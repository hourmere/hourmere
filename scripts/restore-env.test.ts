import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const guide = readFileSync(
  process.env.HOURMERE_SELF_HOSTING_GUIDE ??
    new URL('apps/site/src/content/docs/docs/self-hosting.md', root),
  'utf8',
)
const rewrites = Array.from(
  guide.matchAll(/awk '\n([\s\S]*?)\n' \.env > "\$env_update"/g),
  (match, index) => ({
    name: index === 0 ? 'Caddy migration' : 'restore drill',
    awk: match[1] ?? '',
  }),
)
const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0
const sourceSelection = 'docker-compose.yml:docker-compose.proxy.yml:docker-compose.worker.yml'

function rewrite(awk: string, assignment: string) {
  const directory = mkdtempSync(join(tmpdir(), 'hourmere-restore-env-'))
  try {
    writeFileSync(join(directory, '.env'), `${assignment}\nHOURMERE_VERSION=1.0.0\nKEEP=value\n`, {
      mode: 0o600,
    })
    const result = spawnSync('awk', [awk, '.env'], { cwd: directory, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    return result.stdout
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function services(env: string) {
  const directory = mkdtempSync(join(tmpdir(), 'hourmere-restore-compose-'))
  try {
    for (const file of [
      'docker-compose.yml',
      'docker-compose.image.yml',
      'docker-compose.proxy.yml',
      'docker-compose.worker.yml',
    ]) {
      writeFileSync(join(directory, file), readFileSync(new URL(file, root)))
    }
    writeFileSync(join(directory, '.env'), env, { mode: 0o600 })
    const result = spawnSync(
      'docker',
      ['compose', '-p', basename(directory).toLowerCase(), 'config', '--services'],
      {
        cwd: directory,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          BETTER_AUTH_SECRET: 'synthetic-restore-auth-value-32-characters',
          POSTGRES_PASSWORD: 'synthetic-restore-password',
          PUBLIC_URL: 'https://restore.example.test',
        },
      },
    )
    expect(result.status, result.stderr).toBe(0)
    return result.stdout.trim().split('\n').sort()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

it('finds both documented environment rewrites', () => {
  expect(rewrites).toHaveLength(2)
})

describe.each(
  rewrites.flatMap((rewrite) => [
    { ...rewrite, selection: sourceSelection, published: false },
    {
      ...rewrite,
      name: `${rewrite.name} (image)`,
      selection: sourceSelection.replace(
        'docker-compose.yml:',
        'docker-compose.yml:docker-compose.image.yml:',
      ),
      published: true,
    },
  ]),
)('$name environment rewrite', ({ awk, selection, published }) => {
  it('keeps the exact backed-up application version', () => {
    expect(rewrite(awk, `COMPOSE_FILE=${selection}`)).toContain('HOURMERE_VERSION=1.0.0\n')
    if (published)
      expect(rewrite(awk, `COMPOSE_FILE=${selection}`)).toContain('docker-compose.image.yml')
  })

  it.each([selection, `'${selection}'`, `"${selection}"`])(
    'preserves the worker selected by COMPOSE_FILE=%s',
    (value) => {
      const output = rewrite(awk, `COMPOSE_FILE=${value}`)
      expect(output).toBe(`HOURMERE_VERSION=1.0.0\nKEEP=value\nCOMPOSE_FILE=${selection}\n`)
    },
  )

  it('requires normalization of export COMPOSE_FILE= as documented', () => {
    const assignment = `export COMPOSE_FILE='${selection}'`
    const output = rewrite(awk, assignment)
    // The old exported assignment survives, then the new non-worker value wins in
    // Compose. Make this limitation explicit so operators normalize before restoring.
    expect(output).toBe(
      `${assignment}\nHOURMERE_VERSION=1.0.0\nKEEP=value\nCOMPOSE_FILE=docker-compose.yml:docker-compose.proxy.yml\n`,
    )
    expect(rewrite(awk, assignment.replace(/^export /, ''))).toBe(
      `HOURMERE_VERSION=1.0.0\nKEEP=value\nCOMPOSE_FILE=${selection}\n`,
    )
  })

  it.skipIf(!hasCompose)('renders a worker only after normalizing the exported assignment', () => {
    const assignment = `export COMPOSE_FILE='${selection}'`
    expect(services(rewrite(awk, assignment))).toEqual(['app', 'db', 'proxy'])
    expect(services(rewrite(awk, assignment.replace(/^export /, '')))).toEqual([
      'app',
      'db',
      'proxy',
      'worker',
    ])
  })
})
