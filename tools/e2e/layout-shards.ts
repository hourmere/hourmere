import { layoutViewports } from './layout.ts'

export const layoutShardCount = layoutViewports.length

export function layoutViewportTag({ width, height }: { width: number; height: number }) {
  return `@layout-${width}x${height}`
}

// The baseline's full-registry cases took 6–8 minutes, versus seconds for a
// booking-only case. Give each runner four full cases (two workers) and spread
// the focused checks across runners so they do not displace the matrix cases.
const focusedChecks = new Map([
  ['@layout-320x568', '@layout-notifications'],
  ['@layout-320x256', '@layout-oauth'],
  ['@layout-390x844', '@layout-team-bookings'],
  ['@layout-768x1024', '@layout-readiness'],
  ['@layout-1024x768', '@layout-preparation'],
  ['@layout-1280x720', '@layout-booking-polish'],
  ['@layout-3840x2160', '@layout-org-budget'],
])

export function auditShardArgs(suite: string, shard: string): string[] {
  if (!/^[1-9]\d*\/[1-9]\d*$/.test(shard)) throw new Error('Invalid UI shard')
  const [index, total] = shard.split('/')
  if (suite !== 'layout' || Number(total) !== layoutShardCount) return [`--shard=${shard}`]

  const viewport = layoutViewports[Number(index) - 1]
  if (!viewport) throw new Error('Invalid layout shard index')
  const tag = layoutViewportTag(viewport)
  const tags = [tag, focusedChecks.get(tag)].filter(Boolean)
  return [`--grep=(?:${tags.join('|')})(?=\\s|$)`]
}
