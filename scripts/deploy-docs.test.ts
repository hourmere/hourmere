import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { deploymentPasteSkipReason, pasteIntoZshPty } from './deploy-docs-pty.ts'

const zshPtySkipReason = deploymentPasteSkipReason(process.env)

const guide = readFileSync(
  process.env.HOURMERE_DEPLOY_GUIDE ??
    fileURLToPath(new URL('../apps/site/src/content/docs/docs/self-hosting.md', import.meta.url)),
  'utf8',
)
const changelog = readFileSync(
  process.env.HOURMERE_DEPLOY_CHANGELOG ??
    fileURLToPath(new URL('../CHANGELOG.md', import.meta.url)),
  'utf8',
)
const updates = [...guide.matchAll(/env_update=\$\(mktemp[\s\S]*?mv "\$env_update" \.env/g)]
const base = 'docker-compose.yml'
const image = 'docker-compose.image.yml'
const proxy = 'docker-compose.proxy.yml'
const worker = 'docker-compose.worker.yml'
const selections = [
  { name: 'image', file: `${base}:${image}:${proxy}`, worker: false, image: true },
  {
    name: 'image worker',
    file: `'${base}:${image}:${proxy}:${worker}'`,
    worker: true,
    image: true,
  },
  { name: 'legacy', file: undefined, worker: false },
  { name: 'current', file: 'old.yml', worker: false },
  { name: 'plain', file: base, worker: false },
  { name: 'proxy', file: `${base}:${proxy}`, worker: false },
  { name: 'plain worker', file: `${base}:${worker}`, worker: true },
  { name: 'proxy worker', file: `${base}:${proxy}:${worker}`, worker: true },
  { name: 'single-quoted worker', file: `'${base}:${proxy}:${worker}'`, worker: true },
  { name: 'double-quoted worker', file: `"${base}:${proxy}:${worker}"`, worker: true },
  { name: 'worker before proxy', file: `${base}:${worker}:${proxy}`, worker: true },
  { name: 'commented worker', file: `${base} # optional :${worker}`, worker: false },
  { name: 'different worker file', file: `${base}:${worker}.disabled`, worker: false },
  { name: 'relative worker path', file: `${base}:./${worker}`, worker: false },
]

type InteractiveResult = { status: number | null; stdout: string; stderr: string }

// No errexit and no bracketed paste: each physical line reaches the nested interactive
// shell only after its next primary/continuation prompt. An unscoped exit would return
// subsequent pasted lines to the outer shell, just as sudo -i / su - would.
async function pasteIntoNestedShell(
  commands: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  zshPty = false,
): Promise<InteractiveResult> {
  const lines = [
    'operator_shell=outer',
    zshPty ? 'zsh -f -i' : 'sh -i',
    'operator_shell=nested',
    ...(zshPty
      ? [`[[ -t 0 && -o interactive && ! -o interactivecomments ]] && printf 'ZSH_PTY_READY\\n'`]
      : []),
    ...commands.split('\n'),
    'block_status=$?',
    `printf 'BLOCK_RESULT:%s:%s\\n' "$operator_shell" "$block_status"`,
    'exit 0',
    `printf 'OUTER_RESULT:%s\\n' "$operator_shell"`,
    'exit 0',
  ]
  if (zshPty) return pasteIntoZshPty(`${lines.join('\n')}\n`, cwd, env)
  const shell = spawn('sh', ['-i'], {
    cwd,
    env: { ...env, PS1: 'HOURMERE_PRIMARY> ', PS2: 'HOURMERE_CONTINUE> ' },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  })
  let stdout = ''
  let stderr = ''
  let prompts = 0
  let consumedPrompts = 0
  let closed = false
  let wake: (() => void) | undefined
  shell.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  shell.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
    prompts = [...stderr.matchAll(/HOURMERE_(?:PRIMARY|CONTINUE)> /g)].length
    wake?.()
  })
  shell.stdin.on('error', () => {})
  const completion = new Promise<InteractiveResult>((resolve, reject) => {
    shell.on('error', reject)
    shell.on('close', (status) => {
      closed = true
      wake?.()
      resolve({ status, stdout, stderr })
    })
  })
  const stopOwnedShells = () => {
    shell.stdin.destroy()
    if (shell.pid && !closed) {
      try {
        process.kill(-shell.pid, 'SIGKILL')
      } catch {}
    }
  }
  const timeout = setTimeout(stopOwnedShells, 5000)
  try {
    for (const line of lines) {
      while (prompts === consumedPrompts && !closed)
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      if (closed) break
      consumedPrompts += 1
      shell.stdin.write(`${line}\n`)
    }
    shell.stdin.end()
    return await completion
  } finally {
    clearTimeout(timeout)
    stopOwnedShells()
  }
}

function expectInteractiveShells(result: InteractiveResult, status: number) {
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout, result.stderr).toContain(`BLOCK_RESULT:nested:${status}\n`)
  expect(result.stdout, result.stderr).toContain('OUTER_RESULT:outer\n')
}

async function executePastedCommands(
  commands: string | undefined,
  {
    worker: enabled,
    proxy: hasProxy,
    failCommand = '',
    zshPty = false,
    appImage = 'ghcr.io/hourmere/hourmere:X.Y.Z',
    workerImage = 'ghcr.io/hourmere/hourmere:X.Y.Z',
    shellVersion,
  }: {
    worker: boolean
    proxy: boolean
    failCommand?: string
    zshPty?: boolean
    appImage?: string
    workerImage?: string
    shellVersion?: string
  },
) {
  if (!commands) throw new Error('Labelled instructions must include runnable commands')
  const directory = mkdtempSync(join(tmpdir(), 'hourmere-pasted-docs-'))
  try {
    const scripts = join(directory, 'scripts')
    const bin = join(directory, 'bin')
    const backupDirectory = join(directory, 'backup')
    mkdirSync(scripts)
    mkdirSync(bin)
    writeFileSync(join(directory, '.env'), 'synthetic-backup-settings\n')
    const log = `printf '%s\\n' "$command" >> "$CALL_LOG"
`
    const rejectShellOverride = `if [ "\${COMPOSE_FILE+x}" = x ]; then exit 9; fi\n`
    const fail = '[ "$command" != "$FAIL_COMMAND" ] || exit 7\n'
    for (const mode of ['enable', 'disable']) {
      writeFileSync(
        join(scripts, `${mode}-worker.sh`),
        `#!/bin/sh\ncommand=${mode}-worker\n${rejectShellOverride}${log}${fail}`,
        { mode: 0o755 },
      )
    }
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/sh
command="$*"
case "$command" in
  'compose cp proxy:/data '*) command='compose cp proxy:/data' ;;
  'compose cp proxy:/config '*) command='compose cp proxy:/config' ;;
esac
${rejectShellOverride}${log}case "$command" in
  'compose config --images app') printf '%s\\n' postgres:18-alpine "\${HOURMERE_VERSION:+ghcr.io/hourmere/hourmere:}\${HOURMERE_VERSION:-$APP_IMAGE_OUTPUT}" ;;
  'compose config --images worker') printf '%s\\n' postgres:18-alpine "\${HOURMERE_VERSION:+ghcr.io/hourmere/hourmere:}\${HOURMERE_VERSION:-$WORKER_IMAGE_OUTPUT}" ;;
  'compose config --services') printf '%s\\n' app db${hasProxy ? ' proxy' : ''}${enabled ? ' worker' : ''} ;;
  'compose exec -T db pg_dump -U hourmere -d hourmere -Fc') printf '%s\\n' synthetic-dump ;;
  'compose pull'|'compose pull proxy db'|'compose pull db'|'compose stop app'|'compose stop app worker'|'compose stop worker'|'compose stop app proxy'|'compose up -d --build --wait'|'compose up -d --wait'|'compose cp proxy:/data'|'compose cp proxy:/config') ;;
  *) exit 1 ;;
esac
${fail}`,
      { mode: 0o755 },
    )
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh
command="git $*"
${log}${fail}
if [ "$*" = 'rev-parse HEAD' ]; then printf '%s\\n' synthetic-commit; fi
`,
      { mode: 0o755 },
    )
    writeFileSync(join(bin, 'curl'), `#!/bin/sh\ncommand=health\n${log}${fail}`, { mode: 0o755 })
    writeFileSync(
      join(bin, 'install'),
      `#!/bin/sh
command='install .env'
${log}${fail}exec /usr/bin/install "$@"
`,
      { mode: 0o755 },
    )
    const callLog = join(directory, 'calls')
    const result = await pasteIntoNestedShell(
      // Keep the documented destination inside the owned test directory.
      commands.replace(/^ {2}backup_dir=.*$/m, '  backup_dir="$BACKUP_DIRECTORY" &&'),
      directory,
      {
        PATH: `${bin}:${process.env.PATH}`,
        CALL_LOG: callLog,
        BACKUP_DIRECTORY: backupDirectory,
        COMPOSE_FILE: 'conflicting-shell-selection.yml',
        FAIL_COMMAND: failCommand,
        APP_IMAGE_OUTPUT: appImage,
        WORKER_IMAGE_OUTPUT: workerImage,
        ...(shellVersion === undefined ? {} : { HOURMERE_VERSION: shellVersion }),
      },
      zshPty,
    )
    const dump = join(backupDirectory, 'hourmere.dump')
    return {
      result,
      calls: existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n') : [],
      dump: existsSync(dump) ? readFileSync(dump, 'utf8') : undefined,
      backupDirectory,
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('documented deployment operations', () => {
  it.each([
    [
      'README',
      readFileSync(
        process.env.HOURMERE_DEPLOY_README ?? new URL('../README.md', import.meta.url),
        'utf8',
      ),
    ],
    ['self-hosting guide', guide],
  ])(
    'makes a pinned published image primary and retains the source alternative in the %s',
    (_name, source) => {
      const blocks = [...source.matchAll(/```sh\n([\s\S]*?)\n```/g)].map((match) => match[1])
      const install = blocks.find((block) => block?.includes('git clone --branch v1.0.0'))
      expect(install).toContain('./scripts/setup.sh --image')
      expect(install).toContain('docker compose pull\ndocker compose up -d --wait')
      expect(install).not.toContain('--build')
      expect(source).toContain('HOURMERE_VERSION=1.0.0')
      expect(source).toContain('docker-compose.image.yml')
      expect(source).toContain('./scripts/setup.sh --source')
      expect(source).toContain('docker compose up -d --build --wait')
      expect(source).not.toMatch(/no prebuilt public image is published/i)
      expect(source.replace(/\s+/g, ' ')).toMatch(/restore the previous `HOURMERE_VERSION`/i)
    },
  )

  it('uses image setup for the independent-install example', () => {
    expect(guide).toContain('COMPOSE_PROJECT_NAME=hourmere-staging ./scripts/setup.sh --image')
  })

  it.each(['Single-container', 'Separate-worker'])(
    'pins the %s image upgrade and restores the private version before startup rollback',
    (title) => {
      const section = guide.split(`### ${title} upgrade\n`)[1]?.split('\n### ')[0]
      expect(section).toContain("HOURMERE_VERSION='1.0.1'")
      expect(section).toMatch(
        /docker compose pull &&[\s\S]*?docker compose stop app(?: worker)? &&\n {2}docker compose up -d --wait/,
      )
      expect(section).not.toContain('--build')
      expect(section?.replace(/\s+/g, ' ')).toContain(
        'Before the new-version `up`, restore the previous `HOURMERE_VERSION` from the backup',
      )
    },
  )

  it('requires a root host in every deployment and a portless HTTPS host for bundled Caddy', () => {
    expect(guide).toMatch(
      /Every deployment must serve Hourmere at the root of its own host name,\s+without a path prefix/,
    )
    expect(guide).toMatch(
      /The bundled proxy additionally requires an HTTPS host name without\s+a port/,
    )
  })

  it('mirrors the calendar-reply forwarding example with its whole-mailbox settings page', () => {
    const notifications = readFileSync(
      new URL('../apps/site/src/content/docs/docs/notifications.md', import.meta.url),
      'utf8',
    )
    const example = notifications.match(
      /For example, in \[Zoho Mail[\s\S]*?delivery failures\./,
    )?.[0]
    expect(example).toBeDefined()
    expect(example).toContain('**Settings → Mail Accounts → Forwards**')
    expect(guide.replace(/\s+/g, ' ')).toContain(example?.replace(/\s+/g, ' '))
  })

  it.each(selections)(
    'persists migration and restore settings from $name backups',
    ({ file, worker: enabled, image: published }) => {
      expect(updates).toHaveLength(2)
      for (const [index, update] of updates.entries()) {
        const directory = mkdtempSync(join(tmpdir(), 'hourmere-deploy-docs-'))
        try {
          const previous = file
            ? `COMPOSE_PROJECT_NAME=old\nCOMPOSE_FILE=${file}\nAPP_IMAGE=old:tag\n${published ? "HOURMERE_VERSION='1.0.0'\n" : ''}PROXY_SUBNET=old\nPROXY_IP=old\nPROXY_DYNAMIC_RANGE=old\n`
            : ''
          const preserved =
            "BETTER_AUTH_SECRET='synthetic-preserved-value'\nPOSTGRES_PASSWORD='synthetic-password'\n"
          writeFileSync(join(directory, '.env'), `${preserved}DATABASE_URL=unused\n${previous}`)
          const result = spawnSync('sh', ['-eu', '-c', update[0]], {
            cwd: directory,
            encoding: 'utf8',
          })
          expect(result.status).toBe(0)
          const text = readFileSync(join(directory, '.env'), 'utf8')
          expect(text.startsWith(preserved)).toBe(true)
          expect(text).not.toMatch(/^DATABASE_URL=/m)
          expect(text.match(/^COMPOSE_PROJECT_NAME=/gm)).toHaveLength(1)
          expect(text).toContain(`COMPOSE_PROJECT_NAME=hourmere${index === 1 ? '-restore' : ''}\n`)
          expect(text.match(/^COMPOSE_FILE=/gm)).toHaveLength(1)
          expect(text).toContain(
            `COMPOSE_FILE=${base}${published ? `:${image}` : ''}:${proxy}${enabled ? `:${worker}` : ''}\n`,
          )
          if (published) expect(text).toContain("HOURMERE_VERSION='1.0.0'\n")
          expect(text).toContain(`APP_IMAGE=hourmere:${index === 1 ? 'restore' : 'local'}\n`)
          const octet = index === 1 ? 63 : 62
          expect(text).toContain(`PROXY_SUBNET=172.30.${octet}.0/28\n`)
          expect(text).toContain(`PROXY_IP=172.30.${octet}.2\n`)
          expect(text).toContain(`PROXY_DYNAMIC_RANGE=172.30.${octet}.8/29\n`)
          expect(statSync(join(directory, '.env')).mode & 0o777).toBe(0o600)
        } finally {
          rmSync(directory, { recursive: true, force: true })
        }
      }
    },
  )

  it('starts only the database before requiring restore-drill isolation', () => {
    const drill = guide.split('To test restoration,')[1]?.split('For actual recovery,')[0]
    if (!drill) throw new Error('Restore drill instructions must exist')
    expect(
      [...drill.matchAll(/^docker compose (?:up|start|run).*$/gm)].map(([line]) => line),
    ).toEqual(['docker compose up -d --wait db'])
    expect(drill).toMatch(
      /Do not start the\s+restored app or\s+workers for a drill until SMTP, provider credentials and outbound webhooks\s+have been isolated/,
    )
    expect(drill).toMatch(
      /For a plain-mode restore, replace the whole line\s+with `COMPOSE_FILE='docker-compose\.yml:docker-compose\.image\.yml:docker-compose\.worker\.yml'`/,
    )
    expect(drill).toContain(
      "`COMPOSE_FILE='docker-compose.yml:docker-compose.image.yml'` otherwise",
    )
    expect(drill).toContain(
      'preserves the exact\n`docker-compose.image.yml` and `docker-compose.worker.yml` filenames',
    )
    expect(drill).toContain(
      'does not recognise `./docker-compose.worker.yml` or\n`export COMPOSE_FILE=` forms',
    )
    expect(drill).toMatch(
      /Before running the rewrite, replace those forms with the\s+complete quoted line/,
    )
    expect(drill).toMatch(
      /verify the rewritten selection before starting any app\s+or worker[.:][\s\S]*?compose_services=\$\(docker compose config --services\)[\s\S]*?grep -qx worker/,
    )
  })

  it('pulls the pinned image before creating the stopped proxy and restoring its state', () => {
    expect(guide).toContain(`docker compose pull
docker compose create proxy
docker compose cp "$backup_dir/caddy-data/." proxy:/data
docker compose cp "$backup_dir/caddy-config/." proxy:/config
docker compose up -d --wait`)
    expect(guide).not.toContain('create --build proxy')
    expect(guide).not.toMatch(/docker compose --project-name hourmere-restore/)
  })

  const separate = guide.split('## Run workers separately\n')[1]?.split('\n### ')[0]
  const readme = readFileSync(
    process.env.HOURMERE_DEPLOY_README ?? fileURLToPath(new URL('../README.md', import.meta.url)),
    'utf8',
  )
  const configuration = readFileSync(
    process.env.HOURMERE_DEPLOY_CONFIGURATION ??
      fileURLToPath(
        new URL('../apps/site/src/content/docs/docs/configuration.md', import.meta.url),
      ),
    'utf8',
  )

  it.each([
    ['README', readme],
    ['self-hosting guide', guide],
  ])('uses the operator example hostname in the %s', (_name, source) => {
    expect(source).not.toMatch(/\bapp\.hourmere\.com\b/)
    const healthCommands = source.match(/curl[^\n]+https:\/\/[^\s]+\/api\/health/g) ?? []
    expect(healthCommands.length).toBeGreaterThan(0)
    for (const command of healthCommands) {
      expect(command).toContain('https://hourmere.example.com/api/health')
    }
  })

  const enableCommands = (source: string | undefined) => verificationCommands(source)
  const upgradeCommands = (title: string) =>
    guide.split(`### ${title} upgrade\n`)[1]?.match(/```sh\n([\s\S]*?)\n```/)?.[1]

  const verificationCommands = (section: string | undefined) =>
    [...(section ?? '').matchAll(/```sh\n([\s\S]*?)\n```/g)]
      .map((match) => match[1])
      .find((block) => block?.includes('docker compose config --services'))
  const procedures = [
    {
      name: 'README worker setup',
      commands: enableCommands(readme),
      worker: true,
      helper: 'enable',
    },
    {
      name: 'configuration worker setup',
      commands: enableCommands(configuration),
      worker: true,
      helper: 'enable',
    },
    {
      name: 'self-hosting worker setup',
      commands: enableCommands(separate),
      worker: true,
      helper: 'enable',
    },
    {
      name: 'single-container switch',
      commands: verificationCommands(
        guide.split('### Switch back to a single container\n')[1]?.split('\n## ')[0],
      ),
      worker: false,
      helper: 'disable',
    },
    {
      name: 'webhook n8n setup',
      commands: verificationCommands(
        guide.split('## Private webhook receivers\n')[1]?.split('\n## ')[0],
      ),
      worker: true,
    },
    {
      name: 'restore drill',
      commands: verificationCommands(
        guide.split('To test restoration,')[1]?.split('For actual recovery,')[0],
      ),
      worker: true,
      verificationOnly: true,
    },
    {
      name: 'Single-container',
      commands: upgradeCommands('Single-container'),
      upgrade: true,
      worker: false,
    },
    {
      name: 'Separate-worker',
      commands: upgradeCommands('Separate-worker'),
      upgrade: true,
      worker: true,
      helper: 'enable',
    },
    {
      name: 'Source single-container',
      commands: upgradeCommands('Source single-container'),
      upgrade: true,
      sourceBuild: true,
      worker: false,
    },
    {
      name: 'Source separate-worker',
      commands: upgradeCommands('Source separate-worker'),
      upgrade: true,
      sourceBuild: true,
      worker: true,
      helper: 'enable',
    },
  ]

  const backupCommands = verificationCommands(
    guide.split('## Back up and restore\n')[1]?.split('To test restoration,')[0],
  )
  const guardedProcedures = [...procedures, { name: 'backup', commands: backupCommands }]

  it('executes every guarded shell block as a single subshell', () => {
    const blocks = [readme, configuration, guide].flatMap((source) =>
      [...source.matchAll(/```sh\n([\s\S]*?)\n```/g)]
        .map((match) => match[1])
        .filter((block) => block?.includes('grep -qx') || block?.includes('exit 1')),
    )
    expect(blocks).toHaveLength(guardedProcedures.length)
    expect(guardedProcedures.map(({ commands }) => commands).sort()).toEqual(blocks.sort())
    for (const { name, commands } of guardedProcedures) {
      expect(commands, name).toMatch(/^\(\n(?: {2}[^\n]*\n)+\)$/)
      expect(commands, name).not.toMatch(/^\s*#/m)
      expect(spawnSync('sh', ['-n', '-c', commands ?? '']).status, name).toBe(0)
      expect(commands?.match(/docker compose config --services/g), name).toHaveLength(1)
    }
  })

  describe.each(procedures)(
    '$name commands',
    ({ commands, upgrade, worker: needsWorker, helper, verificationOnly, sourceBuild }) => {
      const prefix = [
        ...(upgrade ? ['git fetch --tags', 'git checkout vX.Y.Z'] : []),
        ...(helper ? [`${helper}-worker`] : []),
      ]
      const imageChecks =
        upgrade && !sourceBuild
          ? [
              'compose config --images app',
              ...(needsWorker ? ['compose config --images worker'] : []),
            ]
          : []
      const startup = [
        ...imageChecks,
        ...(upgrade
          ? [
              sourceBuild ? 'compose pull proxy db' : 'compose pull',
              `compose stop app${needsWorker ? ' worker' : ''}`,
            ]
          : []),
        ...(verificationOnly
          ? []
          : [sourceBuild ? 'compose up -d --build --wait' : 'compose up -d --wait']),
        ...(upgrade ? ['health'] : []),
      ]
      it.for([
        { name: 'missing proxy', proxy: false, failCommand: '', status: 1 },
        {
          name: 'Compose error with expected services',
          proxy: true,
          failCommand: 'compose config --services',
          status: 7,
        },
      ])(
        'keeps $name contained during a non-bracketed zsh PTY paste',
        async ({ proxy, failCommand, status }, context) => {
          if (zshPtySkipReason) context.skip(zshPtySkipReason)
          const { result, calls } = await executePastedCommands(commands, {
            worker: needsWorker,
            proxy,
            failCommand,
            zshPty: true,
          })
          expect(result.stdout, result.stderr).toContain('ZSH_PTY_READY\n')
          expectInteractiveShells(result, status)
          expect(calls).toEqual([...prefix, 'compose config --services'])
        },
      )

      it.for(upgrade ? [false, true] : [])(
        'pastes a plain-mode upgrade with the proxy check deleted (guard passes: %s)',
        async (verified, context) => {
          if (zshPtySkipReason) context.skip(zshPtySkipReason)
          const plain = commands
            ?.replace(
              /^ {2}\{ printf .*grep -qx proxy \|\|\n {4}\{ echo "Proxy service is missing;[^\n]*\n/m,
              '',
            )
            .replace('docker compose pull proxy db', 'docker compose pull db')
          expect(plain).not.toContain('grep -qx proxy')
          const { result, calls } = await executePastedCommands(plain, {
            worker: needsWorker,
            proxy: false,
            failCommand: verified ? '' : 'compose config --services',
            zshPty: true,
          })
          expect(result.stdout, result.stderr).toContain('ZSH_PTY_READY\n')
          expectInteractiveShells(result, verified ? 0 : 7)
          expect(calls).toEqual([
            ...prefix,
            'compose config --services',
            ...(verified ? startup.map((call) => call.replace('pull proxy db', 'pull db')) : []),
          ])
        },
      )

      it.each([
        { worker: true, proxy: true },
        { worker: true, proxy: false },
        { worker: false, proxy: true },
        { worker: false, proxy: false },
      ])('stops before startup when a verification fails (%j)', async ({ worker, proxy }) => {
        const verified = proxy && worker === needsWorker
        const { result, calls } = await executePastedCommands(commands, { worker, proxy })
        expectInteractiveShells(result, verified ? 0 : 1)
        expect(calls).toEqual([
          ...prefix,
          'compose config --services',
          ...(verified ? startup : []),
        ])
        if (!verified)
          expect(result.stdout).toMatch(
            /(?:service|deployment).*?(?:missing|enabled|separate worker)/i,
          )
      })

      it('rejects a Compose error even when it prints the expected services', async () => {
        const { result, calls } = await executePastedCommands(commands, {
          worker: needsWorker,
          proxy: true,
          failCommand: 'compose config --services',
        })
        expectInteractiveShells(result, 7)
        expect(calls).toEqual([...prefix, 'compose config --services'])
      })

      it.each(prefix.filter((call) => !call.startsWith('compose ')))(
        'stops when prerequisite %s fails',
        async (failCommand) => {
          const { result, calls } = await executePastedCommands(commands, {
            worker: needsWorker,
            proxy: true,
            failCommand,
          })
          expectInteractiveShells(result, 7)
          expect(calls).toEqual(prefix.slice(0, prefix.indexOf(failCommand) + 1))
        },
      )

      it.each(upgrade ? startup.filter((call) => /^compose (pull|stop) /.test(`${call} `)) : [])(
        'stops before startup when %s fails',
        async (failCommand) => {
          const { result, calls } = await executePastedCommands(commands, {
            worker: needsWorker,
            proxy: true,
            failCommand,
          })
          expectInteractiveShells(result, 7)
          expect(calls).toEqual([
            ...prefix,
            'compose config --services',
            ...startup.slice(0, startup.indexOf(failCommand) + 1),
          ])
        },
      )
    },
  )

  describe.each(['Single-container', 'Separate-worker'])('%s image selection', (title) => {
    const needsWorker = title === 'Separate-worker'
    const commands = upgradeCommands(title)
    const prefix = [
      'git fetch --tags',
      'git checkout vX.Y.Z',
      ...(needsWorker ? ['enable-worker'] : []),
      'compose config --services',
    ]
    it.each([
      { name: 'source app', appImage: 'hourmere:local' },
      { name: 'wrong exact version', appImage: 'ghcr.io/hourmere/hourmere:9.9.9' },
      { name: 'floating tag', appImage: 'ghcr.io/hourmere/hourmere:latest' },
      { name: 'lookalike registry', appImage: 'ghcrXio/hourmere/hourmere:X.Y.Z' },
    ])('rejects $name before pulling or stopping', async ({ appImage }) => {
      const { result, calls } = await executePastedCommands(commands, {
        worker: needsWorker,
        proxy: true,
        appImage,
      })
      expectInteractiveShells(result, 1)
      expect(result.stdout).toContain('Image overlay or HOURMERE_VERSION is not selected')
      expect(calls).toEqual([...prefix, 'compose config --images app'])
    })

    it.each(needsWorker ? ['hourmere:local', 'ghcr.io/hourmere/hourmere:9.9.9'] : [])(
      'rejects a mismatched worker (%s) before pulling or stopping',
      async (workerImage) => {
        const { result, calls } = await executePastedCommands(commands, {
          worker: needsWorker,
          proxy: true,
          workerImage,
        })
        expectInteractiveShells(result, 1)
        expect(result.stdout).toContain('Worker image does not match the release')
        expect(calls).toEqual([
          ...prefix,
          'compose config --images app',
          'compose config --images worker',
        ])
      },
    )

    it.each(['app', ...(needsWorker ? ['worker'] : [])])(
      'rejects a config error even with the expected %s image output',
      async (service) => {
        const { result, calls } = await executePastedCommands(commands, {
          worker: needsWorker,
          proxy: true,
          failCommand: `compose config --images ${service}`,
        })
        expectInteractiveShells(result, 7)
        expect(calls).toEqual([
          ...prefix,
          'compose config --images app',
          ...(service === 'worker' ? ['compose config --images worker'] : []),
        ])
      },
    )

    it.for([false, true])(
      'uses the private version despite an exported shell override (zsh PTY: %s)',
      async (zshPty, context) => {
        if (zshPty && zshPtySkipReason) context.skip(zshPtySkipReason)
        const { result, calls } = await executePastedCommands(commands, {
          worker: needsWorker,
          proxy: true,
          shellVersion: '9.9.9',
          zshPty,
        })
        expectInteractiveShells(result, 0)
        expect(calls).toContain(`compose stop app${needsWorker ? ' worker' : ''}`)
        expect(calls).toContain('compose up -d --wait')
      },
    )
  })

  it.each([
    ['README', readme],
    ['self-hosting guide', guide],
  ])('documents the source-to-image switch in the %s', (_name, source) => {
    const section = source
      .split('### Switch a source installation to the published image\n')[1]
      ?.split('\n### ')[0]
    expect(section).toBeDefined()
    expect(section?.replace(/\s+/g, ' ')).toMatch(
      /insert `docker-compose.image.yml` immediately after `docker-compose.yml` in `COMPOSE_FILE`/,
    )
    expect(section).toContain("COMPOSE_FILE='docker-compose.yml:docker-compose.image.yml'")
    expect(section).toContain("HOURMERE_VERSION='1.0.1'")
    expect(section).toContain('never `latest`')
    expect(section?.replace(/\s+/g, ' ')).toMatch(
      /(?:Preserve|preserving) proxy, worker and custom overlays/,
    )
    expect(section).toMatch(/(?:run the matching image|image upgrade)/)
  })

  const backupCalls = (enabled: boolean) => [
    'compose config --services',
    ...(enabled ? ['compose stop worker'] : []),
    'compose stop app proxy',
    'compose exec -T db pg_dump -U hourmere -d hourmere -Fc',
    'install .env',
    'git rev-parse HEAD',
    'compose cp proxy:/data',
    'compose cp proxy:/config',
    'compose up -d --wait',
  ]
  it.each([false, true])(
    'stops an enabled worker before backing up (worker: %s)',
    async (enabled) => {
      const { result, calls, dump, backupDirectory } = await executePastedCommands(backupCommands, {
        worker: enabled,
        proxy: true,
      })
      expectInteractiveShells(result, 0)
      expect(calls).toEqual(backupCalls(enabled))
      expect(dump).toBe('synthetic-dump\n')
      expect(result.stdout).toContain(`${backupDirectory}\n`)
    },
  )

  it.each(backupCalls(true))(
    'does not resume the stack after backup prerequisite %s fails',
    async (failCommand) => {
      const { result, calls, backupDirectory } = await executePastedCommands(backupCommands, {
        worker: true,
        proxy: true,
        failCommand,
      })
      expectInteractiveShells(result, 7)
      const expected = backupCalls(true)
      expect(calls).toEqual(expected.slice(0, expected.indexOf(failCommand) + 1))
      expect(result.stdout).not.toContain(`${backupDirectory}\n`)
    },
  )

  it.each([
    [
      'environment example',
      process.env.HOURMERE_DEPLOY_ENV_EXAMPLE ?? new URL('../.env.example', import.meta.url),
    ],
    [
      'worker overlay',
      process.env.HOURMERE_DEPLOY_WORKER_COMPOSE ??
        new URL('../docker-compose.worker.yml', import.meta.url),
    ],
  ])('chains the worker verification comment in the %s', (_name, path) => {
    expect(readFileSync(path, 'utf8')).toContain(
      '# docker compose config --services | grep -qx worker && docker compose up -d --build --wait',
    )
  })

  it('uses release tags for 1.0 upgrades and isolates pre-1.0 main-tracking notes', () => {
    const upgrade = guide.split('## Upgrade and roll back\n')[1]?.split('\n## ')[0]
    if (!upgrade) throw new Error('Upgrade instructions must exist')
    const [releases, legacy] = upgrade.split('### Upgrading from a pre-1.0 checkout\n')
    expect(releases).toContain('For 1.0 and later, check out the intended release tag')
    expect(releases).not.toContain('No stable release has been published yet')
    expect(releases).toContain("HOURMERE_VERSION='1.0.1'")
    expect(releases).toContain('### Source-build upgrades')
    expect(releases).not.toContain('git pull --ff-only')
    for (const title of [
      'Single-container',
      'Separate-worker',
      'Source single-container',
      'Source separate-worker',
    ]) {
      expect(upgradeCommands(title)).toMatch(
        /^\(\n {2}git fetch --tags &&\n {2}git checkout vX\.Y\.Z &&\n/,
      )
    }
    expect(legacy).toContain('Pre-1.0 deployments are source deployments.')
    expect(legacy).toContain('replace `git fetch --tags` and')
    expect(legacy).toContain('with `git pull --ff-only`')
    expect(legacy).toContain('0037_conference_pending_timeout.sql')
    expect(legacy).toContain('0038_booking_ical_identity.sql')
    expect(legacy).toContain('do not use a rolling deployment')
    expect(legacy).toContain('packages/db/migrations/0037_conference_pending_timeout.md')
    expect(legacy).toContain('/docs/notifications#identity-and-recipients')
    expect(releases).not.toContain('0037_conference_pending_timeout.sql')
    expect(releases).not.toContain('0038_booking_ical_identity.sql')
  })

  it('records a named rollback target alongside the exact deployed commit', () => {
    const upgrade = guide.split('## Upgrade and roll back\n')[1]?.split('\n## ')[0]
    expect(upgrade).toMatch(/Record the current\s+branch name or tag before upgrading/)
    expect(upgrade).toContain("alongside the backup's saved commit")
    expect(upgrade).toContain('`git branch --show-current`')
    expect(upgrade).toContain('`git describe --tags --exact-match`')
    expect(readme).toContain('record the current branch name or tag')
    expect(upgrade).not.toContain('<previous commit or tag>')
    expect(upgrade).not.toMatch(/Record the current\s+commit or tag/)
    for (const title of [
      'Single-container',
      'Separate-worker',
      'Source single-container',
      'Source separate-worker',
    ]) {
      const section = upgrade?.split(`### ${title} upgrade\n`)[1]?.split('\n### ')[0]
      expect(section, title).toMatch(
        /git checkout vX\.Y\.Z &&[\s\S]*?\n```[\s\S]*?If a guard, `docker compose pull` or `docker compose stop` fails after checkout,\nreturn with `git checkout <previous branch or tag>`/,
      )
    }
  })

  it.each([
    {
      name: 'README',
      source: readme,
      restoreLink: 'https://hourmere.com/docs/self-hosting#back-up-and-restore',
    },
    ...[
      'Single-container',
      'Separate-worker',
      'Source single-container',
      'Source separate-worker',
    ].map((title) => ({
      name: `${title} upgrade`,
      source: guide.split(`### ${title} upgrade\n`)[1]?.split('\n### ')[0],
      restoreLink: '#back-up-and-restore',
    })),
  ])(
    'limits the $name checkout rollback to before new-version startup',
    ({ source, restoreLink }) => {
      const note = source
        ?.match(/(?:A checkout-only rollback|If a guard)[\s\S]*?schema is unsafe\./)?.[0]
        .replaceAll('**', '')
        .replace(/\s+/g, ' ')
      expect(note).toContain('`git checkout <previous branch or tag>`')
      expect(note).toMatch(/a guard, `docker compose pull` or `docker compose stop`.*fails/i)
      expect(note).toMatch(/before (?:the new-version `docker compose up` command runs)/)
      expect(note).toContain(
        `Once that \`up\` is attempted, follow [Back up and restore](${restoreLink}), even if it fails:`,
      )
      expect(note).toContain(
        'a new app or worker may already have applied migrations; old code against the new schema is unsafe.',
      )
    },
  )

  it.each([
    ['README', readme],
    ['self-hosting guide', guide],
  ])('explains startup migrations and earlier migration paths in the %s', (_name, source) => {
    const text = source.replace(/\s+/g, ' ')
    expect(text).toMatch(
      /`AUTO_MIGRATE=true` runs application and pg-boss migrations at process startup for every role \(`all`, `web` and `worker`\), not during `pull` or `stop`/,
    )
    expect(text).toContain('there is no separate migrate service.')
    expect(text).toMatch(
      /separately started new-version worker, `npm run db:migrate` or a custom migration job can migrate earlier; if any has started, use/,
    )
    expect(text).toMatch(/even before this Compose `up`/)
    expect(text).toMatch(/including a partial `stop` failure/)
    expect(text).toMatch(/If no service was stopped, only the checkout is needed/)
    expect(text).toMatch(/do not build during this recovery/)
    expect(text).toMatch(
      /pulling the old exact version is safe after restoring its version and overlay/,
    )
  })

  const rollbackProcedures = [
    { name: 'README', source: readme },
    { name: 'self-hosting guide', source: guide },
  ].map(({ name, source }) => ({
    name,
    commands: [...source.matchAll(/```sh\n([\s\S]*?)\n```/g)]
      .map((match) => match[1])
      .find((block) => block?.includes('git checkout "PREVIOUS_BRANCH_OR_TAG"')),
  }))

  describe.each(rollbackProcedures)('$name pre-start recovery', ({ commands }) => {
    it('chains checkout, Compose selection reset and old-image startup in one subshell', () => {
      expect(commands).toBe(`(
  git checkout "PREVIOUS_BRANCH_OR_TAG" &&
  unset COMPOSE_FILE HOURMERE_VERSION &&
  docker compose up -d --wait
)`)
    })

    it.for([false, true])(
      'restarts the old stack after checkout (zsh PTY: %s)',
      async (zshPty, context) => {
        if (zshPty && zshPtySkipReason) context.skip(zshPtySkipReason)
        const { result, calls } = await executePastedCommands(commands, {
          worker: true,
          proxy: true,
          zshPty,
        })
        expectInteractiveShells(result, 0)
        expect(calls).toEqual(['git checkout PREVIOUS_BRANCH_OR_TAG', 'compose up -d --wait'])
      },
    )

    it.for([false, true])(
      'contains a failed checkout without startup (zsh PTY: %s)',
      async (zshPty, context) => {
        if (zshPty && zshPtySkipReason) context.skip(zshPtySkipReason)
        const { result, calls } = await executePastedCommands(commands, {
          worker: true,
          proxy: true,
          failCommand: 'git checkout PREVIOUS_BRANCH_OR_TAG',
          zshPty,
        })
        expectInteractiveShells(result, 7)
        expect(calls).toEqual(['git checkout PREVIOUS_BRANCH_OR_TAG'])
      },
    )
  })

  it('returns detached pre-1.0 main-tracking rollbacks to main before a later pull', () => {
    const legacy = guide.split('### Upgrading from a pre-1.0 checkout\n')[1]
    expect(legacy).toMatch(
      /backup's saved commit identifies the exact pre-upgrade\s+revision: `git pull` advances `main`, so its branch name alone does not undo the update/,
    )
    expect(legacy).toContain(
      'Apply the same checkout-only limit above; otherwise use backup/restore.',
    )
    expect(readme).toMatch(
      /backup's saved commit identifies\s+the exact pre-upgrade revision: `git pull` advances `main`, so its branch name alone does\s+not undo the update/,
    )
    expect(legacy).toMatch(
      /If rollback leaves\s+this `main`-tracking checkout detached, run `git switch main` before the next upgrade so\s+`git pull --ff-only` works/,
    )
    expect(readme).toMatch(
      /If rollback leaves a pre-1\.0 `main`-tracking checkout detached, run\s+`git switch main` before the next upgrade so `git pull --ff-only` works/,
    )
  })

  it.each([
    ['README', readme],
    [
      'separate-worker upgrade',
      guide.split('### Separate-worker upgrade\n')[1]?.split('\n### ')[0],
    ],
  ])('explains how to revert the private worker selection in the %s', (_name, source) => {
    expect(source?.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')).toContain(
      "Git does not undo `enable-worker.sh`'s private `.env` edit.",
    )
    expect(source).toMatch(
      /Before checking out the prior\s+revision, restore only the pre-upgrade `COMPOSE_FILE` assignment from the saved private\s+`\.env` \(remove the assignment if it was absent\), preserving the proxy\/custom overlays\s+and other current settings/,
    )
  })

  it('migrates tracked worker edits before changing revisions and explains orphaned old images', () => {
    const upgrade = guide.split('## Upgrade and roll back\n')[1]?.split('\n## ')[0]
    if (!upgrade) throw new Error('Upgrade instructions must exist')
    expect(upgrade).toContain('tracked edits make `git pull --ff-only` refuse the upgrade')
    expect(upgrade).toMatch(
      /replace or add the\s+complete `COMPOSE_FILE` line in `\.env` before restoring the tracked file[\s\S]*?git restore docker-compose\.yml/,
    )
    for (const source of [upgrade, changelog]) {
      expect(source).toContain('./scripts/enable-worker.sh')
      expect(source).toContain("COMPOSE_FILE='docker-compose.yml:docker-compose.worker.yml'")
      expect(source).toContain(
        "COMPOSE_FILE='docker-compose.yml:docker-compose.proxy.yml:docker-compose.worker.yml'",
      )
      expect(source).toMatch(
        /(?:Keep|keep) (?:any additional )?custom overlays (?:within|inside) the quotes/,
      )
      expect(source).toMatch(
        /(?:docker compose config --services|printf '%s\\n' "\$compose_services") \| grep -qx worker/,
      )
      expect(source).toMatch(
        /Restoring\s+(?:the Compose file\s+)?without selecting (?:the (?:worker )?)?overlay/,
      )
      expect(source).toMatch(/old worker\s+container orphaned\s+on the old\s+image/)
      expect(source).toMatch(/app (?:may remain|possibly) web-only/)
    }
    expect(changelog).toMatch(/restore the tracked\s+Compose file and pull/)
  })

  it('removes the worker container before deselecting its overlay', () => {
    const single = guide.split('### Switch back to a single container\n')[1]?.split('\n## ')[0]
    if (!single) throw new Error('Single-container switch instructions must exist')
    expect(single).toMatch(
      /while the overlay is still selected:[\s\S]*?docker compose rm -sf worker[\s\S]*?Then deselect the overlay with the helper:[\s\S]*?\.\/scripts\/disable-worker\.sh/,
    )
    expect(single).toContain('Remove any old `HOURMERE_ROLE=web`')
    expect(single).toContain('docker compose up -d --wait')
    expect(single).toContain('default `all` role')
    const command = single.match(/```sh\n([^`]*docker compose rm[^`]*)\n```/)?.[1]
    const directory = mkdtempSync(join(tmpdir(), 'hourmere-single-container-docs-'))
    try {
      writeFileSync(
        join(directory, 'docker'),
        `#!/bin/sh\n[ "\${COMPOSE_FILE+x}" != x ] || exit 9\nprintf "%s\\n" "$*" > "$CALL_LOG"\n`,
        { mode: 0o755 },
      )
      const callLog = join(directory, 'calls')
      const result = spawnSync('sh', ['-eu', '-c', command ?? 'exit 1'], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          CALL_LOG: callLog,
          COMPOSE_FILE: 'conflicting-shell-selection.yml',
        },
      })
      expect(result.status).toBe(0)
      expect(readFileSync(callLog, 'utf8')).toBe('compose rm -sf worker\n')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    {
      name: 'backup failure recovery',
      section: guide.split('If backup fails')[1]?.split('Set `backup_dir`')[0],
      calls: ['compose up -d --wait'],
    },
    {
      name: 'restore drill database start',
      section: guide.split('To test restoration,')[1]?.split('The separate `APP_IMAGE`')[0],
      calls: [
        'compose up -d --wait db',
        'compose exec -T db pg_restore -U hourmere -d hourmere --exit-on-error --single-transaction',
        'compose exec -T db psql -U hourmere -d hourmere -Atc SELECT count(*) FROM auth."user";',
      ],
      databaseOnly: true,
    },
    {
      name: 'actual recovery',
      section: guide.split('For actual recovery,')[1]?.split('## Upgrade and roll back')[0],
      calls: [
        'compose pull',
        'compose create proxy',
        'compose cp BACKUP/caddy-data/. proxy:/data',
        'compose cp BACKUP/caddy-config/. proxy:/config',
        'compose up -d --wait',
      ],
    },
  ])('reads .env for standalone $name commands', ({ section, calls, databaseOnly }) => {
    const block = section?.match(/```sh\n([\s\S]*?)\n```/)?.[1]
    if (!block) throw new Error('Standalone Compose instructions must exist')
    // The drill's checkout and .env preparation are covered above; run its database
    // commands after the documented reset of an inherited Compose selection.
    const commands = databaseOnly ? block.split('mv "$env_update" .env\n')[1] : block
    if (!commands) throw new Error('Database commands must follow restore configuration')
    const directory = mkdtempSync(join(tmpdir(), 'hourmere-standalone-docs-'))
    try {
      writeFileSync(join(directory, 'hourmere.dump'), 'synthetic-dump\n')
      writeFileSync(
        join(directory, 'docker'),
        `#!/bin/sh\n[ "\${COMPOSE_FILE+x}" != x ] || exit 9\nprintf "%s\\n" "$*" >> "$CALL_LOG"\n`,
        { mode: 0o755 },
      )
      const callLog = join(directory, 'calls')
      const result = spawnSync('sh', ['-eu', '-c', commands], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          CALL_LOG: callLog,
          COMPOSE_FILE: 'conflicting-shell-selection.yml',
          backup_dir: directory,
        },
      })
      expect(result.status, result.stderr).toBe(0)
      expect(
        readFileSync(callLog, 'utf8').replaceAll(directory, 'BACKUP').trim().split('\n'),
      ).toEqual(calls)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('explains inspection and an incomplete backup before resuming a failed backup', () => {
    const recovery = guide.split('If backup fails')[1]?.split('Set `backup_dir`')[0]
    expect(recovery).toMatch(
      /services remain stopped[\s\S]*Inspect the failed command and partial backup/,
    )
    expect(recovery).toContain('Treat the partial backup as incomplete')
    expect(guide).not.toContain('Continue to `up` only if')
  })
})
