import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const guide = readFileSync(
  new URL('../apps/site/src/content/docs/docs/self-hosting.md', import.meta.url),
  'utf8',
)
const updates = [...guide.matchAll(/env_update=\$\(mktemp[\s\S]*?mv "\$env_update" \.env/g)]

describe('documented deployment operations', () => {
  it.each(['legacy', 'current'])(
    'persists migration and restore settings from %s backups',
    (kind) => {
      expect(updates).toHaveLength(2)
      for (const [index, update] of updates.entries()) {
        const directory = mkdtempSync(join(tmpdir(), 'hourmere-deploy-docs-'))
        try {
          const previous =
            kind === 'current'
              ? 'COMPOSE_PROJECT_NAME=old\nCOMPOSE_FILE=old.yml\nAPP_IMAGE=old:tag\nPROXY_SUBNET=old\nPROXY_IP=old\nPROXY_DYNAMIC_RANGE=old\n'
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
          expect(text).toContain('COMPOSE_FILE=docker-compose.yml:docker-compose.proxy.yml\n')
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
})
