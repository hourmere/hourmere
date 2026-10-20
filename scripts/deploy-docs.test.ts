import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

  it.each([false, true])('stops an enabled worker before backing up (worker: %s)', (enabled) => {
    const backup = guide.match(
      /if docker compose config --services[\s\S]*?pg_dump[^\n]+> "\$backup_dir\/hourmere\.dump"/,
    )?.[0]
    expect(backup, 'backup commands must stop the optional worker').toBeDefined()
    const directory = mkdtempSync(join(tmpdir(), 'hourmere-backup-docs-'))
    try {
      const bin = join(directory, 'bin')
      mkdirSync(bin)
      writeFileSync(
        join(bin, 'docker'),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
case "$*" in
  'compose config --services') printf '%s\\n' app db proxy${enabled ? ' worker' : ''} ;;
  'compose stop worker'|'compose stop app proxy') ;;
  'compose exec -T db pg_dump -U hourmere -d hourmere -Fc') printf '%s\\n' synthetic-dump ;;
  *) exit 1 ;;
esac
`,
        { mode: 0o755 },
      )
      const callLog = join(directory, 'calls')
      const result = spawnSync('sh', ['-eu', '-c', backup ?? 'exit 1'], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          CALL_LOG: callLog,
          backup_dir: directory,
        },
      })
      expect(result.status).toBe(0)
      expect(readFileSync(callLog, 'utf8').trim().split('\n')).toEqual([
        'compose config --services',
        ...(enabled ? ['compose stop worker'] : []),
        'compose stop app proxy',
        'compose exec -T db pg_dump -U hourmere -d hourmere -Fc',
      ])
      expect(readFileSync(join(directory, 'hourmere.dump'), 'utf8')).toBe('synthetic-dump\n')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

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
      /verify the rewritten selection before starting any app\s+or worker:[\s\S]*?docker compose config --services \| grep -qx worker/,
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
  const enableCommands = (source: string | undefined) =>
    source?.match(/```sh\n(unset COMPOSE_FILE[\s\S]*?)\n```/)?.[1]
  const upgradeCommands = (title: string) =>
    guide.split(`### ${title} upgrade\n`)[1]?.match(/```sh\n([\s\S]*?)\n```/)?.[1]

  it('checks the HTTPS proxy beside every standalone worker verification', () => {
    for (const source of [readme, configuration, guide]) {
      const blocks = [...source.matchAll(/```sh\n([\s\S]*?)\n```/g)]
        .map((match) => match[1] ?? '')
        .filter((block) => /^docker compose config --services \| grep -qx worker$/m.test(block))
      expect(blocks.length).toBeGreaterThan(0)
      for (const block of blocks) {
        expect(block).toMatch(
          /docker compose config --services \| grep -qx worker\n# Bundled HTTPS only; omit this check in plain mode\.\ndocker compose config --services \| grep -qx proxy/,
        )
      }
    }
  })

  const procedures = [
    { name: 'README worker setup', commands: enableCommands(readme), upgrade: false, worker: true },
    {
      name: 'configuration worker setup',
      commands: enableCommands(configuration),
      upgrade: false,
      worker: true,
    },
    {
      name: 'self-hosting worker setup',
      commands: enableCommands(separate),
      upgrade: false,
      worker: true,
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
    },
  ]

  describe.each(procedures)('$name commands', ({ commands, upgrade, worker: needsWorker }) => {
    it.each([
      { worker: true, proxy: true },
      { worker: true, proxy: false },
      { worker: false, proxy: true },
      { worker: false, proxy: false },
    ])('checks HTTPS proxy and required roles before startup (%j)', ({ worker, proxy }) => {
      expect(commands, 'labelled instructions must include runnable commands').toBeDefined()
      const directory = mkdtempSync(join(tmpdir(), 'hourmere-worker-docs-'))
      try {
        const scripts = join(directory, 'scripts')
        const bin = join(directory, 'bin')
        mkdirSync(scripts)
        mkdirSync(bin)
        const rejectShellOverride = `if [ "\${COMPOSE_FILE+x}" = x ]; then exit 9; fi\n`
        writeFileSync(
          join(scripts, 'enable-worker.sh'),
          `#!/bin/sh
${rejectShellOverride}printf '%s\\n' enable-worker >> "$CALL_LOG"
`,
          { mode: 0o755 },
        )
        writeFileSync(
          join(bin, 'docker'),
          `#!/bin/sh
${rejectShellOverride}printf '%s\\n' "$*" >> "$CALL_LOG"
case "$*" in
  'compose config --services') printf '%s\\n' app db${proxy ? ' proxy' : ''}${worker ? ' worker' : ''} ;;
  'compose pull proxy db'|'compose stop app'|'compose stop app worker'|'compose up -d --build --wait') ;;
  *) exit 1 ;;
esac
`,
          { mode: 0o755 },
        )
        writeFileSync(join(bin, 'git'), '#!/bin/sh\nprintf "%s\\n" "git $*" >> "$CALL_LOG"\n', {
          mode: 0o755,
        })
        writeFileSync(join(bin, 'curl'), '#!/bin/sh\nprintf "%s\\n" health >> "$CALL_LOG"\n', {
          mode: 0o755,
        })
        const callLog = join(directory, 'calls')
        const result = spawnSync('sh', ['-eu', '-c', commands ?? 'exit 1'], {
          cwd: directory,
          encoding: 'utf8',
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            CALL_LOG: callLog,
            COMPOSE_FILE: 'conflicting-shell-selection.yml',
          },
        })
        const verified = proxy && (!needsWorker || worker)
        expect(result.status).toBe(verified ? 0 : 1)
        expect(readFileSync(callLog, 'utf8').trim().split('\n')).toEqual([
          ...(upgrade ? ['git pull --ff-only'] : []),
          ...(needsWorker ? ['enable-worker', 'compose config --services'] : []),
          ...(!needsWorker || worker ? ['compose config --services'] : []),
          ...(verified
            ? [
                ...(upgrade
                  ? ['compose pull proxy db', `compose stop app${needsWorker ? ' worker' : ''}`]
                  : []),
                'compose up -d --build --wait',
                ...(upgrade ? ['health'] : []),
              ]
            : []),
        ])
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })
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
      expect(source).toContain('docker compose config --services | grep -qx worker')
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
