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
const proxy = 'docker-compose.proxy.yml'
const worker = 'docker-compose.worker.yml'
const selections = [
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
): Promise<InteractiveResult> {
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
    const lines = [
      'operator_shell=outer',
      'sh -i',
      'operator_shell=nested',
      ...commands.split('\n'),
      'block_status=$?',
      `printf 'BLOCK_RESULT:%s:%s\\n' "$operator_shell" "$block_status"`,
      'exit 0',
      `printf 'OUTER_RESULT:%s\\n' "$operator_shell"`,
      'exit 0',
    ]
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
  expect(result.stdout).toContain(`BLOCK_RESULT:nested:${status}\n`)
  expect(result.stdout).toContain('OUTER_RESULT:outer\n')
}

async function executePastedCommands(
  commands: string | undefined,
  {
    worker: enabled,
    proxy: hasProxy,
    failCommand = '',
  }: {
    worker: boolean
    proxy: boolean
    failCommand?: string
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
  'compose config --services') printf '%s\\n' app db${hasProxy ? ' proxy' : ''}${enabled ? ' worker' : ''} ;;
  'compose exec -T db pg_dump -U hourmere -d hourmere -Fc') printf '%s\\n' synthetic-dump ;;
  'compose pull proxy db'|'compose stop app'|'compose stop app worker'|'compose stop worker'|'compose stop app proxy'|'compose up -d --build --wait'|'compose up -d --wait'|'compose cp proxy:/data'|'compose cp proxy:/config') ;;
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
      },
    )
    const dump = join(backupDirectory, 'hourmere.dump')
    return {
      result,
      calls: existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n') : [],
      dump: existsSync(dump) ? readFileSync(dump, 'utf8') : undefined,
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('documented deployment operations', () => {
  it.each(selections)(
    'persists migration and restore settings from $name backups',
    ({ file, worker: enabled }) => {
      expect(updates).toHaveLength(2)
      for (const [index, update] of updates.entries()) {
        const directory = mkdtempSync(join(tmpdir(), 'hourmere-deploy-docs-'))
        try {
          const previous = file
            ? `COMPOSE_PROJECT_NAME=old\nCOMPOSE_FILE=${file}\nAPP_IMAGE=old:tag\nPROXY_SUBNET=old\nPROXY_IP=old\nPROXY_DYNAMIC_RANGE=old\n`
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
          expect(text).toContain(`COMPOSE_FILE=${base}:${proxy}${enabled ? `:${worker}` : ''}\n`)
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
      /For a plain-mode restore, replace the whole line\s+with `COMPOSE_FILE='docker-compose\.yml:docker-compose\.worker\.yml'`/,
    )
    expect(drill).toContain("`COMPOSE_FILE='docker-compose.yml'` otherwise")
    expect(drill).toContain('preserves only the exact\n`docker-compose.worker.yml` filename')
    expect(drill).toContain(
      'does not recognise `./docker-compose.worker.yml` or\n`export COMPOSE_FILE=` forms',
    )
    expect(drill).toMatch(
      /Before running the rewrite, replace those forms with the\s+complete quoted line/,
    )
    expect(drill).toMatch(
      /verify the rewritten selection before starting any app\s+or worker:[\s\S]*?compose_services=\$\(docker compose config --services\)[\s\S]*?grep -qx worker/,
    )
  })

  it('builds the app before creating the stopped proxy and restoring its state', () => {
    expect(guide).toContain(`docker compose build
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
      expect(spawnSync('sh', ['-n', '-c', commands ?? '']).status, name).toBe(0)
      expect(commands?.match(/docker compose config --services/g), name).toHaveLength(1)
    }
  })

  describe.each(procedures)(
    '$name commands',
    ({ commands, upgrade, worker: needsWorker, helper, verificationOnly }) => {
      const prefix = [
        ...(upgrade ? ['git pull --ff-only'] : []),
        ...(helper ? [`${helper}-worker`] : []),
      ]
      const startup = [
        ...(upgrade
          ? ['compose pull proxy db', `compose stop app${needsWorker ? ' worker' : ''}`]
          : []),
        ...(verificationOnly ? [] : ['compose up -d --build --wait']),
        ...(upgrade ? ['health'] : []),
      ]
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

      it.each(upgrade ? startup.slice(0, 2) : [])(
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
      const { result, calls, dump } = await executePastedCommands(backupCommands, {
        worker: enabled,
        proxy: true,
      })
      expectInteractiveShells(result, 0)
      expect(calls).toEqual(backupCalls(enabled))
      expect(dump).toBe('synthetic-dump\n')
    },
  )

  it.each(backupCalls(true).slice(0, -1))(
    'does not resume the stack after backup prerequisite %s fails',
    async (failCommand) => {
      const { result, calls } = await executePastedCommands(backupCommands, {
        worker: true,
        proxy: true,
        failCommand,
      })
      expectInteractiveShells(result, 7)
      const expected = backupCalls(true)
      expect(calls).toEqual(expected.slice(0, expected.indexOf(failCommand) + 1))
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

  it('migrates tracked worker edits before pulling and explains orphaned old images', () => {
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
    expect(single).toContain('docker compose up -d --build --wait')
    expect(single).toContain('default `all` role')
    const command = single.match(/^docker compose rm .+$/m)?.[0]
    const directory = mkdtempSync(join(tmpdir(), 'hourmere-single-container-docs-'))
    try {
      writeFileSync(join(directory, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$*" > "$CALL_LOG"\n', {
        mode: 0o755,
      })
      const callLog = join(directory, 'calls')
      const result = spawnSync('sh', ['-eu', '-c', command ?? 'exit 1'], {
        cwd: directory,
        encoding: 'utf8',
        env: { PATH: `${directory}:${process.env.PATH}`, CALL_LOG: callLog },
      })
      expect(result.status).toBe(0)
      expect(readFileSync(callLog, 'utf8')).toBe('compose rm -sf worker\n')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
