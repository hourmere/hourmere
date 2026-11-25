import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (filename: string) => readFileSync(new URL(filename, import.meta.url), 'utf8')
const manifest = JSON.parse(read('./package.json'))
const lock = JSON.parse(read('./package-lock.json'))

describe('community package requirements', () => {
  it('identifies Hourmere and its source repository in the npm registry', () => {
    expect(manifest.name).toBe('n8n-nodes-hourmere')
    expect(manifest.keywords).toContain('n8n-community-node-package')
    expect(manifest.description).toMatch(/Hourmere.*n8n/)
    expect(manifest.author).toEqual({
      name: 'Cobaltmere, LLC',
      email: 'hello@hourmere.com',
    })
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/hourmere/hourmere.git',
      directory: 'tools/n8n-nodes-hourmere',
    })
    expect(manifest.homepage).toBe('https://hourmere.com/docs/n8n')
    expect(manifest.bugs).toBe('https://github.com/hourmere/hourmere/issues')
    const cliVersion = manifest.devDependencies['@n8n/node-cli']
    expect(cliVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(lock.packages['node_modules/@n8n/node-cli'].version).toBe(cliVersion)
    const [major, minor] = cliVersion.split('.').map(Number)
    expect(major > 0 || minor >= 23).toBe(true)
  })

  it('registers both shipped nodes and their credential with n8n', () => {
    expect(manifest.n8n.n8nNodesApiVersion).toBe(1)
    expect(manifest.n8n.nodes).toEqual([
      'dist/nodes/Hourmere/Hourmere.node.js',
      'dist/nodes/HourmereTrigger/HourmereTrigger.node.js',
    ])
    expect(manifest.n8n.credentials).toEqual(['dist/credentials/HourmereApi.credentials.js'])
  })

  it('has no bundled or installed runtime dependencies except the n8n host peer', () => {
    for (const field of [
      'dependencies',
      'optionalDependencies',
      'bundleDependencies',
      'bundledDependencies',
    ]) {
      expect(manifest[field], field).toBeUndefined()
    }
    expect(manifest.peerDependencies).toEqual({ 'n8n-workflow': '*' })
    expect(manifest.devDependencies['n8n-workflow']).toBe('2.45.1')
  })

  it('runs the official n8n rules with warnings treated as errors', () => {
    expect(manifest.scripts.lint).toBe('eslint . --max-warnings 0')
    const config = read('./eslint.config.mjs')
    expect(config).toContain("const { config } = await import('@n8n/node-cli/eslint')")
    expect(config).toContain('...config,')
  })

  it('ships the AGPL license, documentation, and a changelog entry for the package version', () => {
    expect(manifest.files).toEqual(['dist', 'README.md', 'LICENSE', 'CHANGELOG.md'])
    expect(manifest.license).toBe('AGPL-3.0-only')
    expect(lock.packages[''].license).toBe(manifest.license)
    expect(lock.packages[''].version).toBe(manifest.version)
    expect(read('./LICENSE')).toContain('GNU AFFERO GENERAL PUBLIC LICENSE')
    expect(read('./CHANGELOG.md').split('\n')).toContain(`## ${manifest.version}`)
    const readme = read('./README.md')
    const lines = readme.split('\n')
    for (const section of [
      'Installation',
      'Credentials',
      'Operations',
      'Example workflows',
      'Compatibility and language',
      'Documentation',
      'License',
    ]) {
      expect(lines).toContain(`## ${section}`)
    }
    expect(readme).toContain('AGPL-3.0-only')
  })
})

describe('community package publication', () => {
  it('requires a reviewed release even if lifecycle scripts are skipped', () => {
    expect(manifest.private).toBe(true)
    expect(manifest.publishConfig).toEqual({ registry: 'https://registry.invalid/' })
  })

  it.each([undefined, '', '0', 'true', '1'])(
    'requires explicit publish approval: %s',
    (approval) => {
      const directory = mkdtempSync(join(tmpdir(), 'hourmere-n8n-publish-guard-'))
      try {
        // The lifecycle guard is isolated from registry commands and CI credentials.
        writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest))
        writeFileSync(join(directory, '.npmrc'), read('./.npmrc'))
        const env = { PATH: process.env.PATH, HOURMERE_N8N_PUBLISH: approval }
        const result = spawnSync('npm', ['run', 'prepublishOnly', '--ignore-scripts=false'], {
          cwd: directory,
          env,
          encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(approval === '1' ? 0 : 1)
        if (approval !== '1') {
          expect(result.stderr).toContain('Publishing requires separate approval')
        }
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
})
