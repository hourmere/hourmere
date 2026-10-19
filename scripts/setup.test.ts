import { spawn, spawnSync } from 'node:child_process'
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
const origin = 'https://meet.example.test'
const proxyInput = `\n${origin}\n${smtp}\n${sender}\n`
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
        timeout: 15_000,
        env: { ...process.env, COMPOSE_PROJECT_NAME: '', ...env },
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

describe('first-run deployment setup', { timeout: 20_000 }, () => {
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
    expect(text.includes(`PUBLIC_URL='${origin}'\n`)).toBe(true)
    expect(text.includes("COMPOSE_FILE='docker-compose.yml:docker-compose.proxy.yml'\n")).toBe(true)
    expect(text.includes("COMPOSE_PROJECT_NAME='hourmere'\n")).toBe(true)
    expect(text.match(/^COMPOSE_PROJECT_NAME=/gm)?.length).toBe(1)
    expect(/^DATABASE_URL=/m.test(text)).toBe(false)
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

  it('persists an explicitly selected Compose project for subsequent commands', () => {
    const setup = fixture()
    expect(setup.run(proxyInput, { COMPOSE_PROJECT_NAME: 'hourmere-staging_2' }).status).toBe(0)
    expect(setup.text().includes("COMPOSE_PROJECT_NAME='hourmere-staging_2'\n")).toBe(true)
    expect(setup.text().match(/^COMPOSE_PROJECT_NAME=/gm)?.length).toBe(1)
  })

  it.each([
    'Hourmere',
    '-hourmere',
    '_hourmere',
    'hourmere staging',
    'hourmere.test',
    'hourmere\nOTHER=value',
  ])('rejects an invalid Compose project identity (%j)', (name) => {
    const setup = fixture()
    expect(setup.run(proxyInput, { COMPOSE_PROJECT_NAME: name }).status).toBe(1)
    expect(existsSync(setup.envFile)).toBe(false)
    expect(setup.noStaging()).toBe(true)
  })

  it('requires the proxy origin to be entered explicitly', () => {
    const setup = fixture()
    expect(setup.run(`\n\n${smtp}\n${sender}\n`).status).toBe(1)
    expect(existsSync(setup.envFile)).toBe(false)
    expect(setup.noStaging()).toBe(true)
  })

  it.each([`${sender}\\`, `${sender}\\\\`, `${sender}'\\`])(
    'rejects mail senders ending in a backslash (%j)',
    (mailFrom) => {
      const setup = fixture()
      expect(setup.run(`\n${origin}\n${smtp}\n${mailFrom}\n`).status).toBe(1)
      expect(existsSync(setup.envFile)).toBe(false)
      expect(setup.noStaging()).toBe(true)
    },
  )

  it('supports an explicitly confirmed loopback trial with the plain Compose path', () => {
    const setup = fixture()
    expect(setup.run(plainInput).status).toBe(0)
    const text = setup.text()
    expect(text.includes("COMPOSE_FILE='docker-compose.yml'\n")).toBe(true)
    expect(text.includes("PUBLIC_URL='http://localhost:3000'\n")).toBe(true)
    expect(text.includes("SMTP_URL=''\n")).toBe(true)
    expect(text.includes("MAIL_FROM=''\n")).toBe(true)
    expect(text.includes("COMPOSE_PROJECT_NAME='hourmere'\n")).toBe(true)
    expect(/^DATABASE_URL=/m.test(text)).toBe(false)
  })

  it('disables terminal echo while a real terminal reads SMTP credentials', async () => {
    const setup = fixture()
    // Node's macOS pipe is a socketpair, which script(1) cannot inspect with tcgetattr.
    // cat supplies a real pipe while script gives setup a genuine pseudo-terminal.
    const command =
      process.platform === 'darwin'
        ? 'cat | script -q /dev/null /bin/sh scripts/setup.sh'
        : 'cat | script -q -e -c "/bin/sh scripts/setup.sh" /dev/null'
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: setup.directory,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let transcript = ''
    const steps = [
      ['Deployment mode [proxy/plain] (proxy): ', '\n'],
      ['Public HTTPS origin (required): ', `${origin}\n`],
      ['SMTP URL (hidden; blank only for a private loopback trial): ', `${smtp}\n`],
      ['Mail sender (for example Hourmere <bookings@example.com>): ', `${sender}\n`],
    ]
    let step = 0
    const output = (chunk: Buffer) => {
      transcript += chunk.toString()
      if (transcript.includes(steps[step]?.[0] ?? '\0')) {
        child.stdin.write(steps[step]?.[1])
        step++
        if (step === steps.length) child.stdin.end()
      }
    }
    child.stdout.on('data', output)
    child.stderr.on('data', output)
    const status = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error('Interactive setup did not finish'))
      }, 4000)
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once('exit', (code) => {
        clearTimeout(timeout)
        resolve(code)
      })
    })
    expect(status).toBe(0)
    expect(step).toBe(4)
    expect(transcript.includes(smtp)).toBe(false)
    expect(setup.text().includes('SMTP_URL=')).toBe(true)
  })

  it.each([
    ['http://127.0.0.1:3100', '3100'],
    ['http://localhost:3100', '3100'],
    ['http://127.0.0.1', '80'],
    ['http://localhost', '80'],
  ])('matches the published port to a private trial on %s', (url, port) => {
    const setup = fixture()
    expect(setup.run(`plain\n${url}\n\nyes\n`).status).toBe(0)
    expect(setup.text().includes(`PORT='${port}'\n`)).toBe(true)
    expect(setup.text().match(/^PORT=/gm)?.length).toBe(1)
  })

  it.each(['', 'no', 'y'])('requires the exact private-trial confirmation (%j)', (confirmation) => {
    const setup = fixture()
    expect(setup.run(`plain\n\n\n${confirmation}\n`).status).toBe(1)
    expect(existsSync(setup.envFile)).toBe(false)
  })

  it.each([
    `\n${origin}\n\nyes\n`,
    'plain\nhttps://meet.example.test\n\nyes\n',
    'plain\nhttp://localhost.evil.test\n\nyes\n',
    'plain\nhttp://[::1]:3100\n\nyes\n',
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
    `\n${origin}\nnot-smtp\n${sender}\n`,
    `\n${origin}\n${smtp}\n\n`,
    `\n${origin}\n${smtp}\n   \n`,
    `\n${origin}\n${smtp}\nHourmere\u0001 <bookings@example.test>\n`,
    `\n${origin}\nsmtp://user:password@smtp.test#fragment\n${sender}\n`,
    `\n${origin}\nsmtp://user:password@\n${sender}\n`,
    `\n${origin}\nsmtp://user:password@smtp.test/path\n${sender}\n`,
    `\n${origin}\nsmtp://user:password@smtp.test?query=value\n${sender}\n`,
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

  it.each([
    ['short-one', 'short-two'],
    ['!'.repeat(43) + '=', '?'.repeat(43) + '='],
  ])('rejects distinct malformed random-generator results', (first, second) => {
    const setup = fixture()
    const command = `
if [ ! -e count ]; then
  : > count
  printf '%s\\n' '${first}'
else
  printf '%s\\n' '${second}'
fi`
    expect(setup.run(proxyInput, setup.fakeOpenSSL(command)).status).toBe(1)
    expect(existsSync(setup.envFile)).toBe(false)
  })
})
