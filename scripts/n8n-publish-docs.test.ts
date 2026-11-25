import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const guides = ['tools/n8n-nodes-hourmere/README.md', 'apps/site/src/content/docs/docs/n8n.md']

describe.each(guides)('%s', (path) => {
  const source = read(path)

  it('provides a tarball install before publication and a registry install afterward', () => {
    const [, local = '', registry = ''] = source.split(/^#{2,3} (?:Before|After) npm publication$/m)
    expect(local).toContain('npm ci --ignore-scripts')
    expect(local).toContain('npm run build')
    expect(local).toContain('npm pack --ignore-scripts')
    expect(local).toMatch(/npm install \/absolute\/path\/n8n-nodes-hourmere-\S+\.tgz/)
    expect(registry).toMatch(
      /Once an installable version of `n8n-nodes-hourmere` is published on npm/,
    )
    expect(registry).toMatch(/Settings → Community Nodes →\s+Install/)
    expect(registry).toContain('npm install n8n-nodes-hourmere')
  })

  it('requires n8n approval for Cloud and directs maintainers to the owner workflow', () => {
    expect(source).toMatch(/unverified\. n8n Cloud installation requires approval from n8n/)
    expect(source).toContain('https://github.com/hourmere/hourmere/blob/main/docs/n8n-release.md')
    expect(source).not.toMatch(/\bnpm publish\b/)
  })
})

it('documents the separate release and verification approvals for the owner', () => {
  const runbook = read('docs/n8n-release.md')
  expect(runbook).toContain('Required reviewers')
  expect(runbook).toContain('n8n-npm-release')
  expect(runbook).toMatch(/gh workflow run n8n-release\.yml .*--ref n8n-v0\.1\.0 -f bootstrap=true/)
  expect(runbook).toContain('Staged Packages')
  expect(runbook).toContain('the 2FA challenge')
  expect(runbook).toContain('npx @n8n/scan-community-package n8n-nodes-hourmere')
  expect(runbook).toContain('https://creators.n8n.io/nodes')
})
