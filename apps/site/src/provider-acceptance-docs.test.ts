import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = process.env.HOURMERE_DOCS_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))
const source = (path: string) => readFileSync(join(root, path), 'utf8')
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
const read = (path: string) => normalize(source(path))
const zoomAcceptance =
  'Real-account acceptance was performed on 2026-10-19 against a Zoom development-mode app. Its scope was creating, rescheduling and cancelling a real meeting. Production Zoom Marketplace publication is a separate step for the hosted service; self-hosters use their own Zoom apps.'
const guides = [
  {
    path: 'docs/automatic-zoom.md',
    environment: 'a Zoom development-mode app',
    productionStep: 'Production Zoom Marketplace publication',
    ownApps: 'Zoom apps',
    acceptanceParagraph: `Automated validation uses synthetic providers/mail and helper-owned PostgreSQL. ${zoomAcceptance} Production deauthorization notification delivery still requires operator acceptance of the configured public app and endpoint.`,
  },
  {
    path: 'apps/site/src/content/docs/docs/zoom-connections.md',
    environment: 'a Zoom development-mode app',
    productionStep: 'Production Zoom Marketplace publication',
    ownApps: 'Zoom apps',
    acceptanceParagraph: zoomAcceptance,
  },
  {
    path: 'docs/automatic-google-meet.md',
    environment: 'a Google Cloud test project',
    productionStep: 'Google OAuth verification',
    ownApps: 'Google Cloud projects',
    acceptanceParagraph:
      'Real-account acceptance was performed on 2026-10-19 against a Google Cloud test project. Its scope was creating, rescheduling and cancelling a real meeting. Google OAuth verification is a separate step for the hosted service; self-hosters use their own Google Cloud projects.',
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

  it.each(guides)(
    'keeps the complete acceptance paragraph bounded in $path',
    ({ path, acceptanceParagraph }) => {
      const acceptanceParagraphs = source(path)
        .split(/\r?\n\s*\r?\n/)
        .map(normalize)
        .filter((paragraph) => paragraph.includes('Real-account acceptance'))
      expect(acceptanceParagraphs).toEqual([acceptanceParagraph])
    },
  )

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
