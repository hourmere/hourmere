import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const source = readFileSync(
  process.env.HOURMERE_WORKER_SCRIPT ?? new URL('scripts/enable-worker.sh', root),
  'utf8',
)
const disable = readFileSync(new URL('scripts/disable-worker.sh', root), 'utf8')
const directories: string[] = []
const base = 'docker-compose.yml'
const proxy = 'docker-compose.proxy.yml'
const worker = 'docker-compose.worker.yml'
const prefix =
  "# Keep these exact bytes, including quoting and whitespace.\nBETTER_AUTH_SECRET='synthetic-$literal-value'\nSMTP_URL='smtps://synthetic:pass@smtp.example.test'\n  OTHER_KEY = value # comment\n# COMPOSE_FILE=ignored.yml\n"
const suffix = '\nCOMPOSE_FILE_EXTRA=unrelated\nFINAL_KEY=unterminated'
const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

function fixture(contents?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'hourmere-worker-mode-'))
  directories.push(directory)
  const scripts = join(directory, 'scripts')
  mkdirSync(scripts)
  writeFileSync(join(scripts, 'enable-worker.sh'), source, { mode: 0o755 })
  writeFileSync(join(scripts, 'disable-worker.sh'), disable, { mode: 0o755 })
  const envFile = join(directory, '.env')
  if (contents !== undefined) writeFileSync(envFile, contents, { mode: 0o644 })
  return {
    directory,
    envFile,
    run(mode: 'on' | 'off' = 'on', env: NodeJS.ProcessEnv = {}, trace = false) {
      return spawnSync(
        '/bin/sh',
        [
          ...(trace ? ['-x'] : []),
          join(scripts, `${mode === 'on' ? 'enable' : 'disable'}-worker.sh`),
        ],
        {
          // Scripts resolve the checkout from their own paths, not the caller's cwd.
          cwd: tmpdir(),
          encoding: 'utf8',
          timeout: 10_000,
          env: { PATH: process.env.PATH, ...env },
        },
      )
    },
    text() {
      return readFileSync(envFile, 'utf8')
    },
    noStaging() {
      return !readdirSync(directory).some((name) => name.startsWith('.env.worker.'))
    },
  }
}

const forms = [
  { name: 'plain unquoted', value: base, selected: base },
  { name: 'proxy unquoted', value: `${base}:${proxy}`, selected: `${base}:${proxy}` },
  { name: 'plain single quoted', value: `'${base}'`, selected: base },
  { name: 'proxy single quoted', value: `'${base}:${proxy}'`, selected: `${base}:${proxy}` },
  { name: 'plain double quoted', value: `"${base}"`, selected: base },
  { name: 'proxy double quoted', value: `"${base}:${proxy}"`, selected: `${base}:${proxy}` },
  { name: 'empty unquoted', value: '', selected: base },
  { name: 'empty single quoted', value: "''", selected: base },
  { name: 'empty double quoted', value: '""', selected: base },
  { name: 'unquoted comment', value: `${base} # preserve selection`, selected: base },
  { name: 'single quoted comment', value: `'${base}' # selection`, selected: base },
  { name: 'double quoted comment', value: `"${base}" # selection`, selected: base },
  { name: 'plain worker', value: `${base}:${worker}`, selected: base },
  { name: 'proxy worker', value: `'${base}:${proxy}:${worker}'`, selected: `${base}:${proxy}` },
  { name: 'duplicate worker', value: `${base}:${worker}:${worker}`, selected: base },
  { name: 'relative worker alias', value: `${base}:./${worker}`, selected: base },
  { name: 'custom overlay', value: `${base}:custom.yml`, selected: `${base}:custom.yml` },
]

describe('private worker overlay configuration', () => {
  it.each(forms)('enables and disables $name idempotently', ({ value, selected }) => {
    const setup = fixture(`${prefix}COMPOSE_FILE=${value}${suffix}`)
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = setup.run()
      expect(result.status).toBe(0)
      expect(setup.text() === `${prefix}COMPOSE_FILE='${selected}:${worker}'${suffix}`).toBe(true)
      expect(statSync(setup.envFile).mode & 0o777).toBe(0o600)
      expect(setup.noStaging()).toBe(true)
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(setup.run('off').status).toBe(0)
      expect(setup.text() === `${prefix}COMPOSE_FILE='${selected}'${suffix}`).toBe(true)
      expect(statSync(setup.envFile).mode & 0o777).toBe(0o600)
      expect(setup.noStaging()).toBe(true)
    }
  })

  it.each([base, `'${base}:${proxy}'`, `"${base}:${proxy}:${worker}"`])(
    'handles exported assignments and whitespace (%s)',
    (value) => {
      const setup = fixture(`${prefix} \texport\tCOMPOSE_FILE \t= \t${value}  ${suffix}`)
      expect(setup.run().status).toBe(0)
      const selected = value.includes(proxy) ? `${base}:${proxy}` : base
      expect(setup.text() === `${prefix}COMPOSE_FILE='${selected}:${worker}'${suffix}`).toBe(true)
      expect(setup.run('off').status).toBe(0)
      expect(setup.text() === `${prefix}COMPOSE_FILE='${selected}'${suffix}`).toBe(true)
    },
  )

  it('preserves an existing worker position before custom overrides', () => {
    const setup = fixture(`COMPOSE_FILE='${base}:${worker}:custom.yml'\n`)
    expect(setup.run().status).toBe(0)
    expect(setup.text()).toBe(`COMPOSE_FILE='${base}:${worker}:custom.yml'\n`)
    expect(setup.run('off').status).toBe(0)
    expect(setup.text()).toBe(`COMPOSE_FILE='${base}:custom.yml'\n`)
  })

  it.each(['', prefix, `${prefix}FINAL_KEY=unterminated`])(
    'appends a missing assignment without overwriting any settings (%j)',
    (contents) => {
      const setup = fixture(contents)
      expect(setup.run().status).toBe(0)
      expect(setup.text()).toBe(
        `${contents}${contents && !contents.endsWith('\n') ? '\n' : ''}COMPOSE_FILE='${base}:${worker}'\n`,
      )
      expect(setup.run().status).toBe(0)
      expect(setup.text().match(/^COMPOSE_FILE=/gm)).toHaveLength(1)
    },
  )

  it('preserves CRLF and the final newline', () => {
    const setup = fixture(`OTHER=preserved\r\nCOMPOSE_FILE='${base}:${proxy}'\r\nLAST=yes\r\n`)
    expect(setup.run().status).toBe(0)
    expect(setup.text()).toBe(
      `OTHER=preserved\r\nCOMPOSE_FILE='${base}:${proxy}:${worker}'\r\nLAST=yes\r\n`,
    )
  })

  it('never evaluates values or exposes unrelated settings even with inherited tracing', () => {
    const setup = fixture()
    const marker = join(setup.directory, 'must-not-exist')
    const secret = `synthetic-credential-$(touch ${marker})`
    const contents = `MAIL_FROM='${secret}'\nUNSAFE=$(touch ${marker})\nCOMPOSE_FILE='${base}'\n`
    writeFileSync(setup.envFile, contents)
    const result = setup.run('on', {}, true)
    expect(result.status).toBe(0)
    expect(existsSync(marker)).toBe(false)
    expect((result.stdout + result.stderr).includes(secret)).toBe(false)
    expect(setup.text().startsWith(`MAIL_FROM='${secret}'\n`)).toBe(true)
  })

  it('does not expose the last byte of .env with inherited tracing', () => {
    const setup = fixture(`COMPOSE_FILE='${base}'\nPRIVATE_SETTING=Q`)
    const result = setup.run('on', {}, true)
    expect(result.status).toBe(0)
    expect((result.stdout + result.stderr).includes('Q')).toBe(false)
  })

  it.each(["'", '"'])('preserves assignment-looking lines inside multiline %s values', (quote) => {
    const contents = `OTHER=${quote}first\nCOMPOSE_FILE=${base}\nexport COMPOSE_FILE=${worker}\nlast${quote}\n`
    const setup = fixture(contents)
    expect(setup.run().status).toBe(0)
    expect(setup.text()).toBe(`${contents}COMPOSE_FILE='${base}:${worker}'\n`)
    expect(setup.run('off').status).toBe(0)
    expect(setup.text()).toBe(`${contents}COMPOSE_FILE='${base}'\n`)
  })

  it.each(['file', 'directory', 'dangling'])('refuses a %s symlink without changing it', (kind) => {
    const setup = fixture()
    const target = join(setup.directory, 'target')
    if (kind === 'file') writeFileSync(target, `${prefix}COMPOSE_FILE='${base}'\n`)
    if (kind === 'directory') mkdirSync(target)
    symlinkSync(target, setup.envFile)
    const result = setup.run()
    expect(result.status).toBe(1)
    expect(lstatSync(setup.envFile).isSymbolicLink()).toBe(true)
    if (kind === 'file') expect(readFileSync(target, 'utf8').startsWith(prefix)).toBe(true)
    if (kind === 'directory') expect(readdirSync(target)).toEqual([])
    expect(setup.noStaging()).toBe(true)
  })

  it.each([false, true])('refuses a missing or non-regular .env (directory: %s)', (directory) => {
    const setup = fixture()
    if (directory) mkdirSync(setup.envFile)
    expect(setup.run().status).toBe(1)
    expect(setup.noStaging()).toBe(true)
  })

  it('refuses a symlink introduced after parsing', () => {
    const contents = `${prefix}COMPOSE_FILE='${base}'\n`
    const setup = fixture(contents)
    const target = join(setup.directory, 'race-target')
    writeFileSync(target, contents)
    const bin = join(setup.directory, 'bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'awk'),
      '#!/bin/sh\n/usr/bin/awk "$@"\nrm -f "$RACE_ENV_FILE"\nln -s "$RACE_TARGET" "$RACE_ENV_FILE"\n',
      { mode: 0o755 },
    )
    expect(
      setup.run('on', {
        PATH: `${bin}:${process.env.PATH}`,
        RACE_ENV_FILE: setup.envFile,
        RACE_TARGET: target,
      }).status,
    ).toBe(1)
    expect(lstatSync(setup.envFile).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8') === contents).toBe(true)
    expect(setup.noStaging()).toBe(true)
  })

  it.each([
    `COMPOSE_FILE='${base}'\nexport COMPOSE_FILE='${base}:${proxy}'`,
    `COMPOSE_FILE='${base}`,
    `COMPOSE_FILE="${base}"suffix`,
    `COMPOSE_FILE='${base}':${worker}`,
    `COMPOSE_FILE=${base}::${proxy}`,
    'COMPOSE_FILE=$UNEXPANDED',
    'COMPOSE_FILE="$(touch must-not-exist)"',
    `COMPOSE_FILE='${base}\n:${worker}'`,
    "OTHER='unterminated\nCOMPOSE_FILE=docker-compose.yml",
  ])('rejects ambiguous or nonliteral configuration atomically (%j)', (assignment) => {
    const contents = `${prefix}${assignment}${suffix}`
    const setup = fixture(contents)
    expect(setup.run().status).toBe(1)
    expect(setup.text() === contents).toBe(true)
    expect(setup.noStaging()).toBe(true)
  })

  it('leaves .env untouched and removes staging when parsing fails after partial output', () => {
    const contents = `${prefix}COMPOSE_FILE='${base}'\n`
    const setup = fixture(contents)
    const bin = join(setup.directory, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'awk'), '#!/bin/sh\nprintf partial-output\nexit 1\n', {
      mode: 0o755,
    })
    expect(setup.run('on', { PATH: `${bin}:${process.env.PATH}` }).status).toBe(1)
    expect(setup.text() === contents).toBe(true)
    expect(setup.noStaging()).toBe(true)
  })

  it('prints verification before startup and explicit orphan removal when disabling', () => {
    const setup = fixture(`COMPOSE_FILE='${base}'\n`)
    const enabled = setup.run()
    expect(enabled.status).toBe(0)
    expect(enabled.stdout).toContain('unset COMPOSE_FILE')
    expect(enabled.stdout).toContain(
      'docker compose config --services | grep -qx worker &&\n    docker compose up -d --build --wait',
    )
    const disabled = setup.run('off')
    expect(disabled.status).toBe(0)
    expect(disabled.stdout).toContain('Remove any legacy HOURMERE_ROLE=web setting from .env')
    expect(disabled.stdout).toContain('docker compose up -d --build --wait --remove-orphans')
  })
})

describe.skipIf(!hasCompose)('worker script with real Compose config (no daemon)', () => {
  it.each([false, true])('renders a worker for setup quoting (proxy: %s)', (proxied) => {
    const setup = fixture(
      `COMPOSE_FILE='${base}${proxied ? `:${proxy}` : ''}'\nPOSTGRES_PASSWORD='synthetic-password'\nBETTER_AUTH_SECRET='synthetic-auth-value'\nPUBLIC_URL='https://meet.example.test'\n`,
    )
    for (const file of [base, proxy, worker]) {
      copyFileSync(new URL(file, root), join(setup.directory, file))
    }
    expect(setup.run().status).toBe(0)
    const render = () =>
      spawnSync('docker', ['compose', 'config', '--format', 'json'], {
        cwd: setup.directory,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      })
    const enabled = render()
    expect(enabled.status, 'Compose must render the enabled overlay').toBe(0)
    const enabledServices = JSON.parse(enabled.stdout).services
    expect(enabledServices.app.environment.HOURMERE_ROLE).toBe('web')
    expect(enabledServices.worker.environment.HOURMERE_ROLE).toBe('worker')
    expect(Boolean(enabledServices.proxy)).toBe(proxied)
    expect(setup.run('off').status).toBe(0)
    const disabled = render()
    expect(disabled.status, 'Compose must render the disabled overlay').toBe(0)
    const disabledServices = JSON.parse(disabled.stdout).services
    expect(disabledServices.worker).toBeUndefined()
    expect(disabledServices.app.environment.HOURMERE_ROLE).toBe('')
    expect(Boolean(disabledServices.proxy)).toBe(proxied)
  })
})
