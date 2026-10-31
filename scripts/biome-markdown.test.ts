import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const configPath = process.env.HOURMERE_BIOME_CONFIG ?? join(root, 'biome.json')

it.each([
  { mode: 'check', flags: [] },
  { mode: 'autofix', flags: ['--write'] },
])('preserves title-only Starlight frontmatter during $mode', ({ flags }) => {
  const directory = mkdtempSync(join(tmpdir(), 'hourmere-biome-markdown-'))
  const page = join(directory, 'frontmatter-only.md')
  const source = '---\ntitle: Probe page\n---\n'
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    // The fixture is outside Git; all formatter settings come from the real config.
    config.vcs = { enabled: false }
    writeFileSync(join(directory, 'biome.json'), JSON.stringify(config))
    writeFileSync(page, source)
    const result = spawnSync(
      process.execPath,
      [join(root, 'node_modules/@biomejs/biome/bin/biome'), 'check', ...flags, page],
      { cwd: directory, encoding: 'utf8', timeout: 10_000 },
    )
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(readFileSync(page, 'utf8')).toBe(source)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
