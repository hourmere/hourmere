import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const { scripts } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
  scripts: Record<string, string>
}
const devScripts = Object.entries(scripts).filter(([, command]) =>
  command.includes('docker-compose.dev.yml'),
)
const example = readFileSync(new URL('.env.example', root), 'utf8')
const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0

describe('development Compose isolation', () => {
  it('keeps both database lifecycle commands on the development stack', () => {
    expect(devScripts.map(([name]) => name)).toEqual(expect.arrayContaining(['db:up', 'db:down']))
  })

  it.each(devScripts)('%s explicitly pins the existing development project', (_name, command) => {
    expect(command).toMatch(/^docker compose -p hourmere-dev -f docker-compose\.dev\.yml /)
  })

  it('leaves the production project name unset when copying the example environment', () => {
    expect(example).not.toMatch(/^[\t ]*(?:export[\t ]+)?COMPOSE_PROJECT_NAME[\t ]*=/m)
  })

  it.skipIf(!hasCompose)('preserves the development volume despite production settings', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hourmere-dev-compose-'))
    try {
      writeFileSync(
        join(directory, 'docker-compose.dev.yml'),
        readFileSync(new URL('docker-compose.dev.yml', root)),
      )
      writeFileSync(
        join(directory, '.env'),
        `${example}\nCOMPOSE_PROJECT_NAME=hourmere\nCOMPOSE_FILE=production-only.yml\n`,
      )
      for (const [, command] of devScripts) {
        // Use the actual script's Compose options, replacing only its lifecycle operation.
        const args = command
          .slice('docker '.length)
          .split(/\s+(?:up|down)\b/)[0]
          ?.split(/\s+/)
        expect(args).toBeDefined()
        const result = spawnSync('docker', [...(args ?? []), 'config', '--format', 'json'], {
          cwd: directory,
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            COMPOSE_PROJECT_NAME: 'hourmere',
            COMPOSE_FILE: 'production-only.yml',
          },
        })
        expect(
          result.status,
          'Compose must render the dev script without starting containers',
        ).toBe(0)
        const config = JSON.parse(result.stdout)
        expect(config.name).toBe('hourmere-dev')
        expect(config.volumes['db-data'].name).toBe('hourmere-dev_db-data')
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
