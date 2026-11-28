import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const guides = ['tools/n8n-nodes-hourmere/README.md', 'apps/site/src/content/docs/docs/n8n.md']
const runbookPath = 'docs/n8n-release.md'

// npm can contact its selected registry before refusing to publish a private package.
// A verb like "reach" needs a remote destination. A dry-run can skip the private check.
const noContact =
  /\b(?:before|without|with no|prior to|ahead of)\b(?: any (?:registry|server)\b|(?:\W+\w+){0,3}?\W+(?:contact|quer|touch|request|connect|network|(?:registry|server|internet) access|(?:reach|talk|send)\w*\b[^.!?:]*\b(?:registr(?:y|ies)|servers?|network)\b))|\bno (?:registr(?:y|ies)|servers?) (?:ever )?hears? from npm\b/i
const qualified = (sentence: string) =>
  /\boutside CI\b/i.test(sentence) && /--(?:force|offline)\b/.test(sentence)
const noContactClaims = (source: string) =>
  source
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?:]) /)
    .filter(
      (sentence) =>
        /EPRIVATE|\bprivate\b|refus/i.test(sentence) &&
        noContact.test(sentence) &&
        !qualified(sentence),
    )

it.each([
  'npm refuses with `EPRIVATE` before contacting any registry.',
  'npm refuses with `EPRIVATE` before it contacts any registry.',
  'The refusal happens with no network request.',
  'npm refuses the private package without network access.',
  'Outside CI, npm refuses with `EPRIVATE` before contacting any registry.',
  'npm refuses with `EPRIVATE` before talking to any registry.',
  'The `EPRIVATE` refusal is purely local, so no registry ever hears from npm.',
  'npm refuses with `EPRIVATE` before it sends anything to a registry.',
  'The refusal comes without the registry being contacted.',
])('flags an unqualified no-contact claim: %s', (sentence) => {
  expect(noContactClaims(sentence)).toEqual([sentence])
})

it.each([
  'Dry-runs stop before they reach the private check.',
  'Dry-runs stop before they reach the `private` check.',
  'Outside CI, a real publish with `--force` and `--offline` refuses with `EPRIVATE` with no connection to the local sink.',
])('accepts qualified or unrelated statements: %s', (sentence) => {
  expect(noContactClaims(sentence)).toEqual([])
})

it.each([...guides, runbookPath])(
  '%s avoids claiming that npm refuses before contacting a registry',
  (path) => {
    expect(noContactClaims(read(path))).toEqual([])
  },
)

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
  const runbook = read(runbookPath)
  expect(runbook).toContain('Required reviewers')
  expect(runbook).toMatch(
    /Turn off \*\*Allow administrators to bypass\s+configured protection rules/,
  )
  expect(runbook).toContain('a single **Tag** rule `n8n-v*`')
  expect(runbook).toContain('n8n-npm-release')
  expect(runbook).toMatch(/gh workflow run n8n-release\.yml .*--ref n8n-v0\.1\.0 -f bootstrap=true/)
  expect(runbook).toContain('Staged Packages')
  expect(runbook).toContain('the SHA-1 in the `build` job summary')
  expect(runbook).toContain('the 2FA challenge')
  expect(runbook).toMatch(
    /On the first release, verify whether the version approved\s+after `npm stage` carries provenance/,
  )
  expect(runbook).toContain('the green check beside **Version**')
  expect(runbook).toContain('npx @n8n/scan-community-package n8n-nodes-hourmere')
  expect(runbook).toContain('https://creators.n8n.io/nodes')
})

it.each(['README.md', 'tools/n8n-nodes-hourmere/README.md', runbookPath])(
  '%s documents the license and translation blockers for n8n Cloud verification',
  (path) => {
    const source = read(path).replace(/\s+/g, ' ')
    expect(source).toContain(
      'ineligible for n8n Cloud verification while it is AGPL-3.0-only and ships Simplified Chinese parameter translations',
    )
    expect(source).toContain(
      'https://docs.n8n.io/connect/create-nodes/build-your-node/reference/verification-guidelines.md',
    )
    expect(source).toContain(
      'https://docs.n8n.io/connect/create-nodes/deploy-your-node/submit-community-nodes.md',
    )
  },
)
