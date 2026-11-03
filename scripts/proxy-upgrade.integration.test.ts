import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it } from 'vitest'

const root = new URL('../', import.meta.url)

// Opt in only where Docker daemon access is explicitly authorized. This starts
// only Caddy, using HTTP on an internal network; no app, DB or TLS provider runs.
it.skipIf(process.env.HOURMERE_PROXY_INTEGRATION !== '1')(
  'loads atomic updates, operator edits and rollbacks while keeping unchanged Caddyfiles running',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'hourmere-caddy-upgrade-'))
    const project = basename(dir).toLowerCase()
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DOCKER_HOST: process.env.DOCKER_HOST,
      DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
      COMPOSE_FILE: 'docker-compose.yml:docker-compose.proxy.yml:integration.yml',
      COMPOSE_PROJECT_NAME: project,
      // An inherited stale digest must not suppress recreation.
      CADDYFILE_SHA256: 'inherited-stale-digest',
    }
    const command = (args: string[], required = true) => {
      const result = spawnSync(args[0] ?? '', args.slice(1), {
        cwd: dir,
        env,
        encoding: 'utf8',
        timeout: 90_000,
      })
      if (required) {
        expect(result.error, `could not execute ${args[0]}`).toBeUndefined()
        expect(result.status, `${args.join(' ')}\n${result.stderr}`).toBe(0)
      }
      return result
    }
    const compose = (...args: string[]) => command(['docker', 'compose', ...args]).stdout.trim()
    const fixture = (version: string) => `{
\tadmin off
\tauto_https off
}
:8080 {
\trespond "${version}"
}
`
    const original = fixture('original')
    const sha256 = (contents: string) => createHash('sha256').update(contents).digest('hex')
    const check = (contents: string, version: string) => {
      const id = compose('ps', '-q', 'proxy')
      expect(id).toMatch(/^[a-f0-9]{64}$/)
      const hostHash = sha256(readFileSync(join(dir, 'Caddyfile'), 'utf8'))
      const containerHash = compose(
        'exec',
        '-T',
        'proxy',
        'sha256sum',
        '/etc/caddy/Caddyfile',
      ).split(/\s+/)[0]
      expect(hostHash).toBe(sha256(contents))
      expect(containerHash, 'running proxy must mount the checked-out Caddyfile').toBe(hostHash)
      expect(
        compose('exec', '-T', 'proxy', 'wget', '-qO-', 'http://127.0.0.1:8080'),
        'Caddy must serve the new in-memory configuration',
      ).toBe(version)
      expect(
        command([
          'docker',
          'inspect',
          '--format',
          '{{index .Config.Labels "io.hourmere.caddyfile-sha256"}}',
          id,
        ]).stdout.trim(),
      ).toBe(hostHash)
      return id
    }
    const up = () => command(['sh', 'scripts/compose-up.sh', '-d', '--no-deps', '--wait', 'proxy'])
    const removeResource = (kind: 'network' | 'volume', name: string) => {
      if (command(['docker', kind, 'inspect', name], false).status === 0) {
        command(['docker', kind, 'rm', name])
      }
    }

    try {
      mkdirSync(join(dir, 'scripts'))
      for (const file of [
        'docker-compose.yml',
        'docker-compose.proxy.yml',
        'scripts/compose-up.sh',
      ]) {
        const source =
          file === 'docker-compose.proxy.yml' && process.env.HOURMERE_PROXY_COMPOSE_FILE
            ? process.env.HOURMERE_PROXY_COMPOSE_FILE
            : new URL(file, root)
        copyFileSync(source, join(dir, file))
      }
      writeFileSync(
        join(dir, '.env'),
        [
          'POSTGRES_PASSWORD=synthetic-compose-password',
          'BETTER_AUTH_SECRET=synthetic-compose-auth-secret-32-characters',
          'PUBLIC_URL=http://proxy.example.test',
          'CADDYFILE_SHA256=persisted-stale-digest',
        ].join('\n'),
      )
      writeFileSync(
        join(dir, 'integration.yml'),
        `services:
  proxy:
    ports: !override ["127.0.0.1::8080"]
    networks: !override
      ingress: {}
    restart: "no"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080"]
      interval: 1s
      timeout: 1s
      retries: 30
networks:
  ingress:
    internal: true
    ipam: !reset {}
`,
      )
      writeFileSync(join(dir, 'Caddyfile'), original)
      up()
      const first = check(original, 'original')

      // Git-style replacement changes the inode while preserving its path.
      const updated = fixture('updated')
      writeFileSync(join(dir, 'Caddyfile.next'), updated)
      renameSync(join(dir, 'Caddyfile.next'), join(dir, 'Caddyfile'))
      up()
      const second = check(updated, 'updated')
      expect(second).not.toBe(first)

      // Operators may save the same file in place between upgrades.
      const custom = fixture('operator-customization')
      writeFileSync(join(dir, 'Caddyfile'), custom)
      up()
      const third = check(custom, 'operator-customization')
      expect(third).not.toBe(second)
      expect(readFileSync(join(dir, 'Caddyfile'), 'utf8')).toBe(custom)

      up()
      expect(check(custom, 'operator-customization')).toBe(third)

      writeFileSync(join(dir, 'Caddyfile.next'), original)
      renameSync(join(dir, 'Caddyfile.next'), join(dir, 'Caddyfile'))
      up()
      expect(check(original, 'original')).not.toBe(third)
    } finally {
      // Never use compose down: inspect/remove only this test's exact names.
      try {
        command(['docker', 'compose', 'rm', '-s', '-f', 'proxy'])
        removeResource('network', `${project}_ingress`)
        removeResource('network', `${project}_default`)
        for (const name of ['caddy-data', 'caddy-config', 'db-data']) {
          removeResource('volume', `${project}_${name}`)
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  },
  240_000,
)
