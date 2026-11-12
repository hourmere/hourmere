import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// npm refuses to publish the private n8n package, but only at its last step. Before that it
// can exchange a CI OIDC token at the target registry and, without --force or --offline,
// read the published versions with the operator's token. The package README and the site
// page must say so in this order, and must not claim the refusal comes before any contact.
const root = resolve(import.meta.dirname, '..')
const documents = ['tools/n8n-nodes-hourmere/README.md', 'apps/site/src/content/docs/docs/n8n.md']
const steps = [
  'npm checks `private` only at its last step, though, so it can contact servers first:',
  '1. In a CI job that offers an OIDC ID token, such as GitHub Actions with `id-token: write`, npm obtains that token from the CI provider and exchanges it at the target registry. `--force` and `--offline` do not skip this.',
  '2. Without credentials for the target registry, npm then stops with `ENEEDAUTH`.',
  "3. Without `--force` or `--offline`, npm then reads the package's published versions from the target registry, sending your npm token for that registry.",
  '4. Only then does npm refuse with `EPRIVATE`.',
]
const release = 'HOURMERE_N8N_PUBLISH=1 npm publish --ignore-scripts=false'
const build = 'run `npm ci --ignore-scripts` and `npm run build`, then run the release as'
// "Before contacting any registry", "before any request", "without network access" and the like.
const noContact =
  /\b(?:before|without) (?:contacting|reaching|querying|touching|any (?:request|connection|network|registry|server)|(?:network|registry) access)/i

describe.each(documents)('%s', (path) => {
  const source = readFileSync(resolve(root, path), 'utf8')
  const text = source.replace(/\s+/g, ' ')

  it('lists what npm does before it refuses the private package, in order', () => {
    const positions = steps.map((step) => text.indexOf(step))
    for (const [index, step] of steps.entries()) expect(positions[index], step).toBeGreaterThan(-1)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('never says npm refuses before contacting a registry', () => {
    const claims = text
      .split(/(?<=[.!?:]) /)
      .filter((sentence) => /EPRIVATE|private|refus/i.test(sentence) && noContact.test(sentence))
    expect(claims).toEqual([])
  })

  it('builds dist before the release command', () => {
    const paragraph = source.split(/\n\s*\n/).find((block) => block.includes(release)) ?? ''
    const flat = paragraph.replace(/\s+/g, ' ')
    expect(flat).toContain('`dist` is not committed and no publish script builds it')
    expect(flat.indexOf(build)).toBeGreaterThan(-1)
    expect(flat.indexOf(build)).toBeLessThan(flat.indexOf(release))
  })
})
