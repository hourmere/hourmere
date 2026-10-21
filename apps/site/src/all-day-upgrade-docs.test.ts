import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = process.env.HOURMERE_DOCS_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))
const read = (path: string) => readFileSync(join(root, path), 'utf8').replace(/\s+/g, ' ')
const siteDocs = 'apps/site/src/content/docs/docs'
const changelog =
  read('CHANGELOG.md')
    .split('- **Rebuild Google busy snapshots for all-day dates.**')[1]
    ?.split('- **Restart web and worker processes together for localized sign-in mail.**')[0] ?? ''
const snapshots = [
  { path: 'CHANGELOG.md', text: changelog },
  {
    path: `${siteDocs}/google-calendar.md`,
    text:
      read(`${siteDocs}/google-calendar.md`)
        .split('When upgrading an existing installation,')[1]
        ?.split('Availability over REST, public pages and MCP')[0] ?? '',
  },
  {
    path: 'docs/data-model.md',
    text: read('docs/data-model.md').split('PostgreSQL is the system of record.')[0] ?? '',
  },
]

describe('all-day calendar upgrade documentation', () => {
  it('stops every old 0039 role before new startup and waits for re-sync', () => {
    const guide = read(`${siteDocs}/self-hosting.md`)
    const legacy = guide.split('### Upgrading from a pre-1.0 checkout ')[1]
    const note = legacy
      ?.split('**Migration 0039 requires stopping all old processes;')[1]
      ?.split('**Migration 0038')[0]
    expect(note).toBeDefined()
    expect(note).toContain('do not use a rolling deployment')
    expect(note).toContain(
      'Before any new process applies `0039_calendar_busy_all_day_dates.sql`, stop every old `web`, `all` and `worker` process, including any on other hosts.',
    )
    expect(note).toContain('`docker compose stop app`')
    expect(note).toContain('`docker compose stop worker`')
    expect(note).toMatch(
      /Leave PostgreSQL running, then start every role with the upgraded code and let Google calendar re-sync complete before relying on affected hosts' availability/,
    )
    expect(note).toContain('the first new process applies the migration on startup')
    expect(note).toContain('/docs/google-calendar#busy-time-and-recurring-event-synchronization')
  })

  it('records both unsafe mixed-version behaviors prevented by the version bump', () => {
    expect(changelog).toContain(
      'Without a snapshot version bump, an old web process would skip the new date rows and offer slots on all-day busy days, while an old worker would rewrite the old calendar-zone ranges.',
    )
    expect(changelog).toContain(
      'Stop all old processes so that the new snapshots can remain usable',
    )
  })

  it.each(snapshots)('explains both snapshot-version rejection directions in $path', ({ text }) => {
    expect(text).toMatch(/(?:Snapshot|snapshot) version 2/)
    expect(text).toContain('old web processes reject new snapshots')
    expect(text).toMatch(/new code reject(?:s and rebuilds| and rebuild) version 1 snapshots/)
    expect(text).toMatch(/mixed(?:-version directions| versions) fail closed/)
  })

  it.each(snapshots)(
    'qualifies stale-calendar behavior for round-robin pools in $path',
    ({ text }) => {
      expect(text).toMatch(/personal or collective availability (?:returns|fails with)/)
      expect(text).toContain('`calendar_sync_unavailable`')
      expect(text).toMatch(/round-robin pools omit affected hosts/i)
      expect(text).toMatch(/(?:offers? a fresh slot|offer fresh slots from other hosts)/)
      expect(text).not.toMatch(/Selected calendars return `calendar_sync_unavailable`/)
    },
  )

  it.each(snapshots.filter(({ path }) => path !== 'docs/data-model.md'))(
    'explains when a round-robin pool has no remaining slots in $path',
    ({ text }) => {
      expect(text).toContain(
        'if no slots remain and any host has unavailable sync state, they return the same error',
      )
    },
  )

  it('requires manual old-reader review for DROP NOT NULL changes', () => {
    const policy = read('docs/data-model.md')
    expect(policy).toContain('review `DROP NOT NULL` for compatibility with old readers')
    expect(policy).toContain('this requires manual review and an explicit upgrade note')
    expect(policy).toContain(
      'old availability queries skip the new date rows because `calendar_busy.period` is NULL',
    )
  })
})
