import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

describe('community package publication', () => {
  it('accepts the host workflow peer while pinning the development version', () => {
    expect(manifest.peerDependencies['n8n-workflow']).toBe('*')
    expect(manifest.devDependencies['n8n-workflow']).toBe('2.45.1')
    expect(manifest.private).toBeUndefined()
  })

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
