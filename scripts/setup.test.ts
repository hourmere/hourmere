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

const source = readFileSync(new URL('./setup.sh', import.meta.url), 'utf8')
const example = new URL('../.env.example', import.meta.url)
const directories: string[] = []
const smtp = "smtps://synthetic:$literal'pass@smtp.example.test:465"
const sender = "Hourmere's scheduling <bookings@example.test>"
const proxyInput = `\n\n${smtp}\n${sender}\n`
const plainInput = 'plain\n\n\nyes\n'

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

function fixture(script = source) {
  const directory = mkdtempSync(join(tmpdir(), 'hourmere-setup-'))
  directories.push(directory)
  mkdirSync(join(directory, 'scripts'))
  copyFileSync(example, join(directory, '.env.example'))
  writeFileSync(join(directory, 'scripts/setup.sh'), script, { mode: 0o755 })
  return {
    directory,
    envFile: join(directory, '.env'),
    run(input = proxyInput, env: NodeJS.ProcessEnv = {}, trace = false) {
      return spawnSync('/bin/sh', [...(trace ? ['-x'] : []), 'scripts/setup.sh'], {
        cwd: directory,
        encoding: 'utf8',
        input,
        timeout: 5000,
        env: { ...process.env, ...env },
      })
    },
    text() {
      return readFileSync(join(directory, '.env'), 'utf8')
    },
    noStaging() {
      return !readdirSync(directory).some((name) => name.startsWith('.env.setup.'))
    },
    fakeOpenSSL(body: string) {
      const bin = join(directory, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'openssl'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
      return { PATH: `${bin}:${process.env.PATH}` }
    },
  }
}

function generatedSecret(contents: string, name: string): string {
  return new RegExp(`^${name}='([^']*)'$`, 'm').exec(contents)?.[1] ?? ''
}

describe('first-run deployment setup', () => {
  it('generates independent strong secrets privately and selects the HTTPS Compose path', () => {
    const setup = fixture()
    const result = setup.run(proxyInput, {}, true)
    expect(result.status).toBe(0)
    const text = setup.text()
    expect(statSync(setup.envFile).mode & 0o777).toBe(0o600)
    const auth = generatedSecret(text, 'BETTER_AUTH_SECRET')
    const postgres = generatedSecret(text, 'POSTGRES_PASSWORD')
    // Report booleans so a failed security assertion cannot print a generated secret.
    expect(Buffer.from(auth, 'base64').length === 32).toBe(true)
    expect(Buffer.from(postgres, 'base64').length === 32).toBe(true)
    expect(auth !== postgres).toBe(true)
    const output = result.stdout + result.stderr
    expect([auth, postgres, smtp].some((secret) => output.includes(secret))).toBe(false)
    expect(text.includes("PUBLIC_URL='https://app.hourmere.com'\n")).toBe(true)
    expect(text.includes("COMPOSE_FILE='docker-compose.yml:docker-compose.proxy.yml'\n")).toBe(true)
    expect(text.includes("SIGNUP='first-user'\n")).toBe(true)
    expect(text.includes("AUTO_MIGRATE='true'\n")).toBe(true)
    expect(
      text.includes("SMTP_URL='smtps://synthetic:$literal\\'pass@smtp.example.test:465'\n"),
    ).toBe(true)
    expect(text.includes("MAIL_FROM='Hourmere\\'s scheduling <bookings@example.test>'\n")).toBe(
      true,
    )
    expect(text.includes('CALENDAR_ENCRYPTION_KEY=\n')).toBe(true)
    expect(text.match(/^BETTER_AUTH_SECRET=/gm)?.length).toBe(1)
    expect(setup.noStaging()).toBe(true)
  })

  it('supports an explicitly confirmed loopback trial with the plain Compose path', () => {
    const setup = fixture()
    expect(setup.run(plainInput).status).toBe(0)
    const text = setup.text()
    expect(text.includes("COMPOSE_FILE='docker-compose.yml'\n")).toBe(true)
    expect(text.includes("PUBLIC_URL='http://localhost:3000'\n")).toBe(true)
    expect(text.includes("SMTP_URL=''\n")).toBe(true)
    expect(text.includes("MAIL_FROM=''\n")).toBe(true)
  })

  it.each(['http://127.0.0.1:3100', 'http://[::1]:3100'])(
    'allows an explicit private trial on %s',
    (url) => {
      const setup = fixture()
      expect(setup.run(`plain\n${url}\n\nyes\n`).status).toBe(0)
    },
  )

  it.each(['', 'no', 'y'])('requires the exact private-trial confirmation (%j)', (confirmation) => {
    const setup = fixture()
    expect(setup.run(`plain\n\n\n${confirmation}\n`).status).toBe(1)
    expect(existsSync(setup.envFile)).toBe(false)
  })

  it.each([
    '\n\n\n',
    'plain\nhttps://meet.example.test\n\n',
    'plain\nhttp://localhost.evil.test\n\n',
  ])('refuses public deployments without SMTP', (input) => {
    const setup = fixture()
    expect(setup.run(input).status).toBe(1)
    expect(existsSync(setup.envFile)).toBe(false)
  })

  it.each([
    'https://meet.example.test/path',
    'https://meet.example.test:8443',
    'http://meet.example.test',
    'https://user:pass@meet.example.test',
    'https://meet.example.test#fragment',
    'https://meet.example.test?query=value',
    'https://-meet.example.test',
    'https://127.0.0.1',
  ])('refuses an invalid proxy origin (%s)', (url) => {
    const setup = fixture()
    expect(setup.run(`proxy\n${url}\n${smtp}\n${sender}\n`).status).toBe(1)
    expect(existsSync(setup.envFile)).toBe(false)
  })

  it.each(['plain\nhttp://localhost:0\n', 'invalid\n', '\n'])(
    'cancels incomplete or invalid input',
    (input) => {
      const setup = fixture()
      expect(setup.run(input).status).toBe(1)
      expect(existsSync(setup.envFile)).toBe(false)
      expect(setup.noStaging()).toBe(true)
    },
  )

  it.each([
    `\n\nnot-smtp\n${sender}\n`,
    `\n\n${smtp}\n\n`,
    `\n\nsmtp://user:password@smtp.test#fragment\n${sender}\n`,
  ])('requires a plausible SMTP URL and a matching mail sender', (input) => {
    const setup = fixture()
    const result = setup.run(input)
    expect(result.status).toBe(1)
    expect(existsSync(setup.envFile)).toBe(false)
    expect((result.stdout + result.stderr).includes('user:password')).toBe(false)
  })

  it.each(['file', 'directory', 'symlink', 'dangling-symlink'])(
    'never replaces an existing .env %s',
    (kind) => {
      const setup = fixture()
      const target = join(setup.directory, 'existing')
      if (kind === 'file') writeFileSync(setup.envFile, 'existing configuration\n')
      if (kind === 'directory') mkdirSync(setup.envFile)
      if (kind === 'symlink') writeFileSync(target, 'existing configuration\n')
      if (kind.includes('symlink')) symlinkSync(target, setup.envFile)
      const result = setup.run()
      expect(result.status).toBe(1)
      if (kind === 'file') expect(setup.text()).toBe('existing configuration\n')
      if (kind === 'directory') expect(readdirSync(setup.envFile)).toEqual([])
      if (kind.includes('symlink')) expect(lstatSync(setup.envFile).isSymbolicLink()).toBe(true)
      if (kind === 'symlink') expect(readFileSync(target, 'utf8')).toBe('existing configuration\n')
      if (kind === 'dangling-symlink') expect(existsSync(target)).toBe(false)
      expect(setup.noStaging()).toBe(true)
    },
  )

  it.each(['file', 'directory', 'symlink'])(
    'does not follow or replace a .env %s created during secret generation',
    (kind) => {
      const setup = fixture()
      const action = {
        file: "printf 'concurrent configuration\\n' > .env",
        directory: 'mkdir .env',
        symlink: 'ln -s victim .env',
      }[kind]
      const env = setup.fakeOpenSSL(`
if [ ! -e count ]; then
  : > count
  ${action}
  printf '%s\\n' 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
else
  printf '%s\\n' 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='
fi`)
      expect(setup.run(proxyInput, env).status).toBe(1)
      if (kind === 'file') expect(setup.text()).toBe('concurrent configuration\n')
      if (kind === 'directory') expect(readdirSync(setup.envFile)).toEqual([])
      if (kind === 'symlink') {
        expect(lstatSync(setup.envFile).isSymbolicLink()).toBe(true)
        expect(existsSync(join(setup.directory, 'victim'))).toBe(false)
      }
      expect(setup.noStaging()).toBe(true)
    },
  )

  it.each([
    'exit 1',
    "printf '%s\\n' 'not-a-secret'",
    "printf '%s\\n' 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='",
  ])('fails closed when secret generation fails, is invalid or repeats', (command) => {
    const setup = fixture()
    expect(setup.run(proxyInput, setup.fakeOpenSSL(command)).status).toBe(1)
    expect(existsSync(setup.envFile)).toBe(false)
    expect(setup.noStaging()).toBe(true)
  })
})
