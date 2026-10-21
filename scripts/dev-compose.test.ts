import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const { scripts } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
  scripts: Record<string, string>
}
const devScripts = Object.entries(scripts).filter(([, command]) =>
  command.includes('docker-compose.dev.yml'),
)
const example = readFileSync(new URL('.env.example', root), 'utf8')
const productionFiles = 'docker-compose.yml:docker-compose.proxy.yml:docker-compose.worker.yml'
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

  it.skipIf(!hasCompose)('ignores production proxy and worker settings for development', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hourmere-dev-compose-'))
    const project = basename(directory).toLowerCase()
    const productionProject = `${project}-production`
    try {
      writeFileSync(
        join(directory, 'docker-compose.dev.yml'),
        readFileSync(new URL('docker-compose.dev.yml', root)),
      )
      writeFileSync(
        join(directory, '.env'),
        `${example}\nCOMPOSE_PROJECT_NAME=${productionProject}\nCOMPOSE_FILE=${productionFiles}\n`,
      )
      for (const [, command] of devScripts) {
        // Use the script's options but render under an owned project instead of hourmere-dev.
        const args = command
          .slice('docker '.length)
          .split(/\s+(?:up|down)\b/)[0]
          ?.split(/\s+/)
        expect(args).toBeDefined()
        const projectIndex = args?.indexOf('-p') ?? -1
        if (args && projectIndex >= 0 && args[projectIndex + 1] === 'hourmere-dev') {
          args[projectIndex + 1] = project
        }
        const result = spawnSync('docker', [...(args ?? []), 'config', '--format', 'json'], {
          cwd: directory,
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            COMPOSE_PROJECT_NAME: productionProject,
            COMPOSE_FILE: productionFiles,
          },
        })
        expect(
          result.status,
          'Compose must render the dev script without starting containers',
        ).toBe(0)
        const config = JSON.parse(result.stdout)
        expect(config.name).toBe(project)
        expect(Object.keys(config.services)).toEqual(['db'])
        expect(config.volumes['db-data'].name).toBe(`${project}_db-data`)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
