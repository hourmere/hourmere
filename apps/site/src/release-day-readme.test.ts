import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Mutation probes read source copies without changing the shared worktree.
const readme = readFileSync(
  process.env.HOURMERE_RELEASE_README ??
    fileURLToPath(new URL('../../../README.md', import.meta.url)),
  'utf8',
)
const security = readFileSync(
  process.env.HOURMERE_RELEASE_SECURITY ??
    fileURLToPath(new URL('../../../SECURITY.md', import.meta.url)),
  'utf8',
)

describe('release-day repository documentation', () => {
  const introduction = (readme.split(/^## /m)[0] ?? '').replace(/\s+/g, ' ')

  it('keeps the published image separate from the closed Cloud preview and its waitlist', () => {
    expect(introduction).toContain('Self-host from the published container image;')
    expect(introduction).toContain(
      'Hourmere Cloud is in an invitation-only preview with sign-ups closed.',
    )
    expect(introduction).toContain(
      '[Join the Cloud waitlist](https://hourmere.com/#cloud-waitlist)',
    )
    expect(introduction).not.toMatch(/Hourmere Cloud is coming|Cloud is available|Cloud pricing/i)
  })

  it('announces the released 1.0.0 version and publication date', () => {
    expect(introduction).toContain('Hourmere 1.0.0 was released on November 30, 2026.')
    expect(introduction).not.toMatch(
      /Early development|Nothing here is ready to use yet|planned for/i,
    )
  })

  it('supports the 1.0.x series and directs self-hosters to its latest patch', () => {
    const supported = (security.split('## Supported versions')[1]?.split(/^## /m)[0] ?? '').replace(
      /\s+/g,
      ' ',
    )
    expect(supported).toContain('The `1.0.x` series and the `main` branch receive security fixes;')
    expect(supported).toContain('older releases do not.')
    expect(supported).toContain('Self-hosters should update to the latest `1.0.x` patch release')
    expect(supported).not.toContain('has not reached 1.0')
  })
})
