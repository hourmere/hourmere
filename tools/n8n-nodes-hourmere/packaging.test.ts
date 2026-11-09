import { execFile, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const placeholder = 'https://registry.invalid/'

// Runs npm publish on a manifest copy with the package .npmrc, empty user and global npm
// configuration and a minimal environment, so no CI credentials or OIDC exchange apply.
// Every registry request, including any --registry target below, goes to a local sink
// that drops it, so nothing leaves this machine.
async function publish({
  dryRun = true,
  offline = true,
  args = () => [],
  env = () => ({}),
  npmrc = () => '',
  userConfig = () => '',
}: {
  dryRun?: boolean
  offline?: boolean
  args?: (sink: string) => string[]
  env?: (sink: string) => Record<string, string>
  npmrc?: (sink: string) => string
  userConfig?: (sink: string) => string
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
    const packageConfig = readFileSync(new URL('./.npmrc', import.meta.url), 'utf8')
    writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest))
    writeFileSync(join(directory, '.npmrc'), packageConfig + npmrc(address))
    writeFileSync(join(directory, 'user.npmrc'), userConfig(address))
    writeFileSync(join(directory, 'global.npmrc'), '')
    const { code, stderr } = await new Promise<{ code: unknown; stderr: string }>((resolve) =>
      execFile(
        'npm',
        [
          'publish',
          ...(dryRun ? ['--dry-run'] : []),
          '--ignore-scripts',
          ...(offline ? ['--offline'] : []),
          ...args(address),
        ],
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
        (error, _stdout, stderr) => resolve({ code: error ? (error.code ?? 'killed') : 0, stderr }),
      ),
    )
    const targets = stderr
      .split('\n')
      .flatMap(
        (line) =>
          line.match(
            /^npm notice Publishing to (\S+) with tag \S+ and \S+ access(?: \(dry-run\))?$/,
          )?.[1] ?? [],
      )
    return { code, stderr, targets, connections, sink: address }
  } finally {
    await new Promise((resolve) => sink.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('community package publication', () => {
  it('accepts the host workflow peer while pinning the development version', () => {
    expect(manifest.peerDependencies['n8n-workflow']).toBe('*')
    expect(manifest.devDependencies['n8n-workflow']).toBe('2.45.1')
  })

  it('stays private until the approved publication change removes it', () => {
    expect(manifest.private).toBe(true)
  })

  it('blocks the default publication destination even when lifecycle scripts are skipped', () => {
    expect(manifest.publishConfig).toEqual({ registry: placeholder })
  })

  it.each([
    { source: 'no other registry', options: {}, target: placeholder },
    {
      source: 'an environment registry',
      options: { env: (sink: string) => ({ npm_config_registry: sink }) },
      target: placeholder,
    },
    {
      source: 'a project .npmrc registry',
      options: { npmrc: (sink: string) => `registry=${sink}\n` },
      target: placeholder,
    },
    {
      source: 'an explicit --registry flag',
      options: { args: () => ['--registry', 'http://127.0.0.1:9/'] },
      target: 'http://127.0.0.1:9/',
    },
  ])(
    'names the offline dry-run publication target with $source',
    async ({ options, target }) => {
      const result = await publish(options)
      expect(result.code, result.stderr).toBe(0)
      expect(result.targets).toEqual([target])
      expect(result.connections).toBe(0)
    },
    30_000,
  )

  it('shows that a networked dry-run queries the registry yet still succeeds', async () => {
    // Control for the offline checks: the sink does see a networked dry-run's version lookup.
    const result = await publish({ offline: false })
    expect(result.code, result.stderr).toBe(0)
    expect(result.targets).toEqual([placeholder])
    expect(result.connections).toBeGreaterThan(0)
  }, 30_000)

  it('refuses a real publication while private, whatever the registry or script flags', async () => {
    // A dry-run never reaches npm's private check, so this is a real publish. Its only target
    // and credential belong to the local sink, and npm must refuse before any upload.
    const result = await publish({
      dryRun: false,
      args: (sink) => ['--force', '--registry', sink],
      userConfig: (sink) => `${sink.replace(/^http:/, '')}:_authToken=synthetic-unit-test-token\n`,
    })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/^npm error code EPRIVATE$/m)
    expect(result.targets).toEqual([result.sink])
    expect(result.connections).toBe(0)
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
