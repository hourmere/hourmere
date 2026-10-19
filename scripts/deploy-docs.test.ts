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
      /Do not start the\s+restored app or workers for a drill until SMTP, provider credentials and outbound webhooks\s+have been isolated/,
    )
    expect(drill).toContain(
      'Plain-mode restores remove only `:docker-compose.proxy.yml` from the\nrewritten `COMPOSE_FILE`',
    )
    expect(drill).toContain('keep `:docker-compose.worker.yml` if it\nwas selected')
    expect(drill).toContain('preserves only the exact\n`docker-compose.worker.yml` filename')
    expect(drill).toContain(
      'does not recognise `./docker-compose.worker.yml` or\n`export COMPOSE_FILE=` forms',
    )
    expect(drill).toMatch(/Normalize those forms[\s\S]*?before running the\nrewrite/)
    expect(drill).toMatch(
      /verify the rewritten `COMPOSE_FILE`[\s\S]*?before\nstarting any app or worker/,
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

  it('refreshes dependency images before recreating the upgraded stack', () => {
    expect(guide).toContain(`git pull --ff-only
docker compose pull proxy db
docker compose up -d --build --wait`)
  })

  it('migrates tracked worker edits before pulling and explains orphaned old images', () => {
    const upgrade = guide.split('## Upgrade and roll back\n')[1]?.split('\n## ')[0]
    if (!upgrade) throw new Error('Upgrade instructions must exist')
    expect(upgrade).toContain('tracked edits make `git pull --ff-only` refuse the upgrade')
    expect(upgrade).toMatch(
      /First append\n`:docker-compose\.worker\.yml`[\s\S]*?`COMPOSE_FILE` in `\.env`[\s\S]*?git restore docker-compose\.yml\ngit pull --ff-only/,
    )
    for (const source of [upgrade, changelog]) {
      expect(source).toMatch(
        /First append\s+`:docker-compose\.worker\.yml`[\s\S]*?`COMPOSE_FILE`[\s\S]*?git restore docker-compose\.yml/,
      )
      expect(source).toMatch(/COMPOSE_FILE=docker-compose\.yml:docker-compose\.worker\.yml/)
      expect(source).toMatch(/preserv(?:e|ing)\s+any proxy[\s\S]*?overlay/)
      expect(source).toMatch(
        /Restoring (?:the Compose file )?without selecting (?:the (?:worker )?)?overlay/,
      )
      expect(source).toMatch(/old worker\s+container orphaned\s+on the old image/)
      expect(source).toMatch(/app (?:may remain|possibly) web-only/)
    }
    expect(changelog).toMatch(/git restore docker-compose\.yml`[\s\S]*?pull,[\s\S]*?recreate/)
  })

  it('removes the worker container before deselecting its overlay', () => {
    const single = guide.split('### Switch back to a single container\n')[1]?.split('\n## ')[0]
    if (!single) throw new Error('Single-container switch instructions must exist')
    expect(single).toMatch(
      /while the overlay is still selected:[\s\S]*?docker compose rm -sf worker[\s\S]*?Then remove the worker overlay from `COMPOSE_FILE`/,
    )
    expect(single).toContain('remove any old `HOURMERE_ROLE=web`')
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
