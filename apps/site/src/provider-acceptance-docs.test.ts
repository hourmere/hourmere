import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = process.env.HOURMERE_DOCS_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))
const read = (path: string) => readFileSync(join(root, path), 'utf8').replace(/\s+/g, ' ')
const guides = [
  {
    path: 'docs/automatic-zoom.md',
    environment: 'a Zoom development-mode app',
    productionStep: 'Production Zoom Marketplace publication',
    ownApps: 'Zoom apps',
  },
  {
    path: 'apps/site/src/content/docs/docs/zoom-connections.md',
    environment: 'a Zoom development-mode app',
    productionStep: 'Production Zoom Marketplace publication',
    ownApps: 'Zoom apps',
  },
  {
    path: 'docs/automatic-google-meet.md',
    environment: 'a Google Cloud test project',
    productionStep: 'Google OAuth verification',
    ownApps: 'Google Cloud projects',
  },
]

describe('provider real-account acceptance documentation', () => {
  it.each(guides)('records the real-account acceptance date in $path', ({ path }) => {
    expect(read(path)).toContain('Real-account acceptance was performed on 2026-10-19')
  })

  it.each(guides)('bounds the accepted provider environment in $path', ({ path, environment }) => {
    expect(read(path)).toContain(`against ${environment}.`)
  })

  it.each(guides)(
    'limits acceptance to the real meeting lifecycle in $path',
    ({ path, environment }) => {
      expect(read(path)).toContain(
        `Real-account acceptance was performed on 2026-10-19 against ${environment}. Its scope was creating, rescheduling and cancelling a real meeting.`,
      )
    },
  )

  it.each(
    guides.flatMap(({ path }) =>
      ['published on the Zoom App Marketplace', 'verified by Google', 'fully verified'].map(
        (overclaim) => ({ path, overclaim }),
      ),
    ),
  )('rejects the overclaim "$overclaim" in $path', ({ path, overclaim }) => {
    expect(read(path).toLowerCase()).not.toContain(overclaim.toLowerCase())
  })

  it.each(guides)(
    'distinguishes the hosted production step in $path',
    ({ path, productionStep }) => {
      expect(read(path)).toContain(`${productionStep} is a separate step for the hosted service`)
    },
  )

  it.each(guides)('explains self-hosted app ownership in $path', ({ path, ownApps }) => {
    expect(read(path)).toContain(`self-hosters use their own ${ownApps}.`)
  })

  it.each([
    ['docs/automatic-zoom.md', 'No real Zoom client, grant or meeting was used'],
    ['docs/automatic-zoom.md', 'remain required before this branch can be merged'],
    ['docs/automatic-google-meet.md', 'Actual provider acceptance remains separately authorized'],
  ])('removes stale acceptance wording from %s: %s', (path, staleClaim) => {
    expect(read(path)).not.toContain(staleClaim)
  })
})
