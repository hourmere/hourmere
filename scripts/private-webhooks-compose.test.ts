import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0

it.skipIf(!hasCompose)('keeps the documented n8n network reachable from web and worker', () => {
  const root = new URL('../', import.meta.url)
  const guide = readFileSync(
    new URL('apps/site/src/content/docs/docs/self-hosting.md', root),
    'utf8',
  )
  const section = guide.split('## Private webhook receivers\n')[1]?.split('\n## ')[0]
  const override = section?.match(/```yaml\n([\s\S]*?)\n```/)?.[1]
  expect(override).toBeDefined()
  const directory = mkdtempSync(join(tmpdir(), 'hourmere-private-webhook-compose-'))
  try {
    for (const file of [
      'docker-compose.yml',
      'docker-compose.proxy.yml',
      'docker-compose.worker.yml',
    ])
      writeFileSync(join(directory, file), readFileSync(new URL(file, root), 'utf8'))
    writeFileSync(join(directory, 'docker-compose.webhooks.yml'), override as string)
    writeFileSync(
      join(directory, '.env'),
      [
        'COMPOSE_FILE=docker-compose.yml:docker-compose.proxy.yml:docker-compose.worker.yml:docker-compose.webhooks.yml',
        'POSTGRES_PASSWORD=synthetic-compose-password',
        'BETTER_AUTH_SECRET=synthetic-compose-secret-with-32-characters',
        'PUBLIC_URL=https://private-webhooks.example.test',
        'WEBHOOK_PRIVATE_TARGETS=n8n:5678',
        'N8N_IMAGE=synthetic-n8n:config-only',
      ].join('\n'),
    )
    const result = spawnSync(
      'docker',
      ['compose', '--env-file', '.env', 'config', '--format', 'json'],
      {
        cwd: directory,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      },
    )
    expect(result.status, 'Compose must merge the documented override').toBe(0)
    const merged = JSON.parse(result.stdout) as {
      services: Record<
        string,
        {
          networks: Record<string, unknown>
          environment: Record<string, string>
          ports?: unknown[]
        }
      >
    }
    expect(Object.keys(merged.services.app?.networks ?? {})).toEqual([
      'default',
      'ingress',
      'webhook-receivers',
    ])
    expect(Object.keys(merged.services.worker?.networks ?? {})).toEqual([
      'default',
      'webhook-receivers',
    ])
    expect(Object.keys(merged.services.n8n?.networks ?? {})).toEqual(['webhook-receivers'])
    for (const role of ['app', 'worker'])
      expect(merged.services[role]?.environment.WEBHOOK_PRIVATE_TARGETS).toBe('n8n:5678')
    expect(merged.services.worker?.ports ?? []).toEqual([])
    expect(merged.services.n8n?.ports ?? []).toEqual([])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
