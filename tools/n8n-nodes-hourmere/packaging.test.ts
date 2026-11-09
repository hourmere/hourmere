import { execFile, spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const placeholder = 'https://registry.invalid/'

// Dry-runs a publication of a manifest copy with empty npm configuration and no credentials.
// Every registry request goes to a local sink that drops it, so nothing leaves this machine.
async function dryRunPublish({
  offline = true,
  args = [],
  env = () => ({}),
}: {
  offline?: boolean
  args?: string[]
  env?: (sink: string) => Record<string, string>
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'hourmere-n8n-publish-target-'))
  let connections = 0
  const sink = createServer((socket) => {
    connections += 1
    socket.destroy()
  })
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve))
  const address = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/`
  try {
    writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest))
    copyFileSync(new URL('./.npmrc', import.meta.url), join(directory, '.npmrc'))
    writeFileSync(join(directory, 'user.npmrc'), '')
    writeFileSync(join(directory, 'global.npmrc'), '')
    const { stderr } = await promisify(execFile)(
      'npm',
      ['publish', '--dry-run', '--ignore-scripts', ...(offline ? ['--offline'] : []), ...args],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          PATH: process.env.PATH,
          npm_config_cache: join(directory, 'cache'),
          npm_config_userconfig: join(directory, 'user.npmrc'),
          npm_config_globalconfig: join(directory, 'global.npmrc'),
          npm_config_proxy: address,
          npm_config_https_proxy: address,
          npm_config_fetch_retries: '0',
          npm_config_update_notifier: 'false',
          ...env(address),
        },
      },
    )
    const targets = stderr
      .split('\n')
      .flatMap((line) => line.match(/^npm notice Publishing to (\S+) .*\(dry-run\)$/)?.[1] ?? [])
    return { targets, connections }
  } finally {
    await new Promise((resolve) => sink.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('community package publication', () => {
  it('accepts the host workflow peer while pinning the development version', () => {
    expect(manifest.peerDependencies['n8n-workflow']).toBe('*')
    expect(manifest.devDependencies['n8n-workflow']).toBe('2.45.1')
    expect(manifest.private).toBeUndefined()
  })

  it('blocks the default publication destination even when lifecycle scripts are skipped', () => {
    expect(manifest.publishConfig).toEqual({ registry: placeholder })
  })

  it('names the placeholder in the offline dry-run publication line', async () => {
    const result = await dryRunPublish()
    expect(result.targets).toEqual([placeholder])
    expect(result.connections).toBe(0)
  }, 30_000)

  it('keeps the placeholder over an environment registry, not over --registry', async () => {
    const environment = await dryRunPublish({ env: (sink) => ({ npm_config_registry: sink }) })
    expect(environment.targets).toEqual([placeholder])
    expect(environment.connections).toBe(0)
    const flag = await dryRunPublish({ args: ['--registry', 'http://127.0.0.1:9/'] })
    expect(flag.targets).toEqual(['http://127.0.0.1:9/'])
    expect(flag.connections).toBe(0)
  }, 30_000)

  it('shows that a networked dry-run queries the registry yet still succeeds', async () => {
    // Control for the offline checks: the sink does see a networked dry-run's version lookup.
    const result = await dryRunPublish({ offline: false })
    expect(result.targets).toEqual([placeholder])
    expect(result.connections).toBeGreaterThan(0)
  }, 30_000)

  it.each([undefined, '', '0', 'true', '1'])(
    'requires explicit publish approval: %s',
    (approval) => {
      const directory = mkdtempSync(join(tmpdir(), 'hourmere-n8n-publish-guard-'))
      try {
        // Run only the lifecycle guard in an isolated source copy. Never run npm publish.
        writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest))
        const env = { ...process.env }
        delete env.HOURMERE_N8N_PUBLISH
        if (approval !== undefined) env.HOURMERE_N8N_PUBLISH = approval
        const result = spawnSync('npm', ['run', 'prepublishOnly', '--ignore-scripts=false'], {
          cwd: directory,
          env,
          encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(approval === '1' ? 0 : 1)
        if (approval !== '1')
          expect(result.stderr).toContain('Publishing requires separate approval')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
})
