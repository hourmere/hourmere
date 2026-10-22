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
const image = 'docker-compose.image.yml'
const worker = 'docker-compose.worker.yml'
const composeKeys = ['COMPOSE_FILE-EXTRA', 'COMPOSE_FILE.EXTRA', '9OTHER', 'OTHER[0]', '变量']
const prefix =
  "# Keep these exact bytes, including quoting and whitespace.\nBETTER_AUTH_SECRET='synthetic-$literal-value'\nSMTP_URL='smtps://synthetic:pass@smtp.example.test'\n  OTHER_KEY = value # comment\n# COMPOSE_FILE=ignored.yml\n"
const suffix = '\nCOMPOSE_FILE_EXTRA=unrelated\nFINAL_KEY=unterminated'
const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0
const systemShell = { name: 'system sh', command: '/bin/sh', args: [] as string[] }
const shells = [
  systemShell,
  { name: 'bash POSIX', command: 'bash', args: ['--posix'] },
  { name: 'dash', command: 'dash', args: [] },
  { name: 'BusyBox sh', command: 'busybox', args: ['sh'] },
].filter(({ command, args }) => spawnSync(command, [...args, '-c', 'exit 0']).status === 0)

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
    run(
      mode: 'on' | 'off' = 'on',
      env: NodeJS.ProcessEnv = {},
      trace = false,
      shell = systemShell,
    ) {
      return spawnSync(
        shell.command,
        [
          ...shell.args,
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
  { name: 'published image', value: `'${base}:${image}'`, selected: `${base}:${image}` },
  {
    name: 'published image with proxy',
    value: `'${base}:${image}:${proxy}'`,
    selected: `${base}:${image}:${proxy}`,
  },
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

  it.each(['on', 'off'] as const)('appends with CRLF when switching %s', (mode) => {
    for (const contents of ['FIRST=yes\r\nLAST=yes\r\n', 'FIRST=yes\r\nLAST=unterminated']) {
      const setup = fixture(contents)
      const selected = `${base}${mode === 'on' ? `:${worker}` : ''}`
      expect(setup.run(mode).status).toBe(0)
      expect(setup.text()).toBe(
        `${contents}${contents.endsWith('\n') ? '' : '\r\n'}COMPOSE_FILE='${selected}'\r\n`,
      )
      expect(setup.run(mode).status).toBe(0)
      expect(setup.text().match(/^COMPOSE_FILE=/gm)).toHaveLength(1)
      expect(setup.noStaging()).toBe(true)
    }
  })

  it.each(['on', 'off'] as const)('refuses a leading UTF-8 BOM when switching %s', (mode) => {
    for (const first of ['OTHER=preserved', `COMPOSE_FILE='${base}:${proxy}'`, '# comment']) {
      const contents = `\uFEFF${first}\n${first.startsWith('COMPOSE_FILE=') ? '' : `COMPOSE_FILE='${base}:${proxy}'\n`}`
      const setup = fixture(contents)
      const result = setup.run(mode)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Remove the leading UTF-8 BOM from .env')
      expect(result.stderr).toContain('save as UTF-8 without BOM')
      expect(setup.text() === contents).toBe(true)
      expect(statSync(setup.envFile).mode & 0o777).toBe(0o644)
      expect(setup.noStaging()).toBe(true)
    }
  })

  it.each(
    [
      `COMPOSE_FILE: ${base}:${proxy}`,
      `COMPOSE_FILE: '${base}:${proxy}'`,
      ` \texport COMPOSE_FILE : "${base}:${proxy}"`,
      `COMPOSE_FILE += ${base}:${proxy}`,
      `COMPOSE_FILE+=${base}:${proxy}`,
      `env COMPOSE_FILE=${base}:${proxy}`,
      'COMPOSE_FILE',
      `COMPOSE_FILE: ${base}:${proxy}\nCOMPOSE_FILE='${base}'`,
      `COMPOSE_FILE='${base}'\nCOMPOSE_FILE: ${base}:${proxy}`,
    ].flatMap((line) => (['on', 'off'] as const).map((mode) => ({ line, mode }))),
  )('refuses unsupported COMPOSE_FILE lines when switching $mode ($line)', ({ line, mode }) => {
    const contents = `${prefix}${line}${suffix}`
    const setup = fixture(contents)
    const result = setup.run(mode)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('COMPOSE_FILE is ambiguous or unsupported')
    expect(result.stderr).toContain('assignment with =')
    expect(result.stderr).toContain('preserving all existing files')
    expect(setup.text() === contents).toBe(true)
    expect(statSync(setup.envFile).mode & 0o777).toBe(0o644)
    expect(setup.noStaging()).toBe(true)
  })

  it('preserves COMPOSE_FILE mentions in comments, other values and longer keys', () => {
    const contents =
      "# COMPOSE_FILE: ignored.yml\nOTHER='COMPOSE_FILE: literal.yml'\nTEXT=COMPOSE_FILE\nCOMPOSE_FILE_EXTRA=unrelated\n"
    const setup = fixture(contents)
    expect(setup.run().status).toBe(0)
    expect(setup.text()).toBe(`${contents}COMPOSE_FILE='${base}:${worker}'\n`)
    expect(setup.run('off').status).toBe(0)
    expect(setup.text()).toBe(`${contents}COMPOSE_FILE='${base}'\n`)
  })

  it.each(['on', 'off'] as const)(
    'gives exact repair instructions for a worker suffix outside quotes when switching %s',
    (mode) => {
      for (const value of [`'${base}':${worker}`, `"${base}:${proxy}":${worker}`]) {
        const contents = `${prefix}COMPOSE_FILE=${value}${suffix}`
        const setup = fixture(contents)
        const result = setup.run(mode)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain(`Move :${worker} inside the closing quote in .env`)
        expect(result.stderr).toContain(`COMPOSE_FILE='${base}:${worker}' (plain)`)
        expect(result.stderr).toContain(`COMPOSE_FILE='${base}:${proxy}:${worker}' (bundled HTTPS)`)
        expect(result.stderr).toContain('Preserve any other existing files')
        expect(result.stderr.includes('synthetic-$literal-value')).toBe(false)
        expect(setup.text() === contents).toBe(true)
        expect(setup.noStaging()).toBe(true)
      }
    },
  )

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

  it.each([
    { quote: "'", separator: '=' },
    { quote: '"', separator: '=' },
    { quote: "'", separator: ':' },
    { quote: '"', separator: ':' },
  ])(
    'preserves assignment-looking lines inside multiline $separator $quote values',
    ({ quote, separator }) => {
      const contents = `OTHER${separator}${quote}first\nCOMPOSE_FILE=${base}:${proxy}\nexport COMPOSE_FILE=${worker}\nlast${quote}\n`
      const setup = fixture(contents)
      expect(setup.run().status).toBe(0)
      expect(setup.text()).toBe(`${contents}COMPOSE_FILE='${base}:${worker}'\n`)
      expect(setup.run('off').status).toBe(0)
      expect(setup.text()).toBe(`${contents}COMPOSE_FILE='${base}'\n`)
    },
  )

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
    expect(enabled.stdout).toContain('unset COMPOSE_FILE HOURMERE_VERSION')
    expect(enabled.stdout).toContain(
      '# Bundled HTTPS only; omit this check in plain mode.\n  docker compose config --services | grep -qx proxy &&\n  docker compose config --services | grep -qx worker',
    )
    expect(enabled.stdout).toContain(
      'docker compose config --services | grep -qx worker &&\n    docker compose up -d --build --wait',
    )
    const disabled = setup.run('off')
    expect(disabled.status).toBe(0)
    expect(disabled.stdout).toContain('Remove any legacy HOURMERE_ROLE=web setting from .env')
    expect(disabled.stdout).toContain('docker compose up -d --build --wait --remove-orphans')
  })

  it.each([image, `./${image}`])(
    'omits source builds when enabling and disabling an image selection (%s)',
    (imageFile) => {
      const setup = fixture(
        `COMPOSE_FILE='${base}:${imageFile}:${proxy}'\nHOURMERE_VERSION='1.0.0'\n`,
      )
      const enabled = setup.run()
      expect(enabled.status).toBe(0)
      expect(enabled.stdout).toContain('docker compose up -d --wait')
      expect(enabled.stdout).not.toContain('--build')
      const disabled = setup.run('off')
      expect(disabled.status).toBe(0)
      expect(disabled.stdout).toContain('docker compose up -d --wait --remove-orphans')
      expect(disabled.stdout).not.toContain('--build')
    },
  )

  it('decides the startup hint from the selection rather than unrelated multiline values', () => {
    const setup = fixture(
      `OTHER='first\nCOMPOSE_FILE=${base}:${image}\nlast'\nCOMPOSE_FILE='${base}:${proxy}'\n`,
    )
    const enabled = setup.run()
    expect(enabled.status).toBe(0)
    expect(enabled.stdout).toContain('docker compose up -d --build --wait')
  })

  it.each(
    [false, true].flatMap((published) =>
      [false, true].map((hasProxy) => ({ published, hasProxy })),
    ),
  )(
    'runs the matching start command only after worker and proxy checks (image: $published, proxy present: $hasProxy)',
    ({ published, hasProxy }) => {
      const setup = fixture(`COMPOSE_FILE='${base}${published ? `:${image}` : ''}:${proxy}'\n`)
      const enabled = setup.run()
      expect(enabled.status).toBe(0)
      const commands = enabled.stdout.split('Run from this checkout:\n')[1]
      expect(commands).toBeDefined()
      const bin = join(setup.directory, 'bin')
      const started = join(setup.directory, 'started')
      mkdirSync(bin)
      writeFileSync(
        join(bin, 'docker'),
        `#!/bin/sh
[ -z "\${COMPOSE_FILE+x}\${HOURMERE_VERSION+x}" ] || exit 98
case "$*" in
  "compose config --services") printf "%s\\n" app db worker; [ "$HAS_PROXY" != true ] || printf "%s\\n" proxy ;;
  "$EXPECTED_START") : > "$STARTED_FILE" ;;
  *) exit 99 ;;
esac
`,
        { mode: 0o755 },
      )
      const run = spawnSync('/bin/sh', ['-c', commands ?? 'exit 99'], {
        encoding: 'utf8',
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HAS_PROXY: String(hasProxy),
          STARTED_FILE: started,
          EXPECTED_START: `compose up -d${published ? '' : ' --build'} --wait`,
          COMPOSE_FILE: 'unrelated-shell-selection.yml',
          HOURMERE_VERSION: '9.9.9',
        },
      })
      expect(run.status).toBe(hasProxy ? 0 : 1)
      expect(existsSync(started)).toBe(hasProxy)
    },
  )
})

describe.each(shells)('worker script portability under $name', (shell) => {
  it('preserves the proxy selection and CRLF through enable and disable', () => {
    const setup = fixture(`OTHER=preserved\r\nCOMPOSE_FILE='${base}:${proxy}'\r\n`)
    expect(setup.run('on', {}, false, shell).status).toBe(0)
    expect(setup.text()).toBe(`OTHER=preserved\r\nCOMPOSE_FILE='${base}:${proxy}:${worker}'\r\n`)
    expect(setup.run('off', {}, false, shell).status).toBe(0)
    expect(setup.text()).toBe(`OTHER=preserved\r\nCOMPOSE_FILE='${base}:${proxy}'\r\n`)
  })

  it('uses CRLF when appending a missing selection', () => {
    const setup = fixture('OTHER=preserved\r\nLAST=unterminated')
    expect(setup.run('on', {}, false, shell).status).toBe(0)
    expect(setup.text()).toBe(
      `OTHER=preserved\r\nLAST=unterminated\r\nCOMPOSE_FILE='${base}:${worker}'\r\n`,
    )
  })

  it('preserves assignment-looking lines inside other colon multiline values', () => {
    for (const quote of ["'", '"']) {
      const contents = `OTHER: ${quote}first\nCOMPOSE_FILE=${base}:${proxy}\nlast${quote}\n`
      const setup = fixture(contents)
      expect(setup.run('on', {}, false, shell).status).toBe(0)
      expect(setup.text()).toBe(`${contents}COMPOSE_FILE='${base}:${worker}'\n`)
      expect(setup.run('off', {}, false, shell).status).toBe(0)
      expect(setup.text()).toBe(`${contents}COMPOSE_FILE='${base}'\n`)
    }
  })

  it.each(
    composeKeys.flatMap((key) =>
      [
        { separator: '=', quote: "'", exported: '' },
        { separator: '=', quote: '"', exported: 'export ' },
        { separator: ':', quote: "'", exported: 'export ' },
        { separator: ':', quote: '"', exported: '' },
      ].map((form) => ({ key, ...form })),
    ),
  )(
    'preserves assignment-looking lines in multiline Compose key $key ($separator $quote, export: $exported)',
    ({ key, separator, quote, exported }) => {
      const contents = `#${key}='unclosed comment\n${exported}${key} ${separator} ${quote}first\nCOMPOSE_FILE=${base}:${proxy}\nexport COMPOSE_FILE=${worker}\nlast${quote}\n`
      const setup = fixture(contents)
      expect(setup.run('on', {}, false, shell).status).toBe(0)
      expect(setup.text()).toBe(`${contents}COMPOSE_FILE='${base}:${worker}'\n`)
      expect(setup.run('off', {}, false, shell).status).toBe(0)
      expect(setup.text()).toBe(`${contents}COMPOSE_FILE='${base}'\n`)
      expect(setup.noStaging()).toBe(true)
    },
  )

  it.each([
    `\uFEFFCOMPOSE_FILE='${base}:${proxy}'\n`,
    `\uFEFFOTHER=yes\nCOMPOSE_FILE='${base}:${proxy}'\n`,
    `COMPOSE_FILE: '${base}:${proxy}'\r\n`,
    `COMPOSE_FILE='${base}:${proxy}':${worker}\n`,
  ])('refuses BOM, colon syntax and broken quoted suffixes without changes (%j)', (contents) => {
    for (const mode of ['on', 'off'] as const) {
      const setup = fixture(contents)
      expect(setup.run(mode, {}, false, shell).status).toBe(1)
      expect(setup.text() === contents).toBe(true)
      expect(setup.noStaging()).toBe(true)
    }
  })
})

describe.skipIf(!hasCompose)('worker script with real Compose config (no daemon)', () => {
  it.each(
    [false, true].flatMap((published) => [false, true].map((proxied) => ({ published, proxied }))),
  )(
    'renders a worker for setup quoting (image: $published, proxy: $proxied)',
    ({ published, proxied }) => {
      const setup = fixture(
        `COMPOSE_FILE='${base}${published ? `:${image}` : ''}${proxied ? `:${proxy}` : ''}'\n${published ? "HOURMERE_VERSION='1.0.0-rc.1'\n" : ''}POSTGRES_PASSWORD='synthetic-password'\nBETTER_AUTH_SECRET='synthetic-auth-value'\nPUBLIC_URL='https://meet.example.test'\n${composeKeys.map((key) => `${key}='first\nCOMPOSE_FILE=ignored.yml\nlast'\n`).join('')}`,
      )
      for (const file of [base, image, proxy, worker]) {
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
      expect(enabledServices.app.image).toBe(
        published ? 'ghcr.io/hourmere/hourmere:1.0.0-rc.1' : 'hourmere:local',
      )
      expect(enabledServices.worker.image).toBe(enabledServices.app.image)
      expect(setup.text().includes(`HOURMERE_VERSION='1.0.0-rc.1'\n`)).toBe(published)
      expect(setup.run('off').status).toBe(0)
      const disabled = render()
      expect(disabled.status, 'Compose must render the disabled overlay').toBe(0)
      const disabledServices = JSON.parse(disabled.stdout).services
      expect(disabledServices.worker).toBeUndefined()
      expect(disabledServices.app.environment.HOURMERE_ROLE).toBe('')
      expect(Boolean(disabledServices.proxy)).toBe(proxied)
      expect(disabledServices.app.image).toBe(enabledServices.app.image)
    },
  )
})
