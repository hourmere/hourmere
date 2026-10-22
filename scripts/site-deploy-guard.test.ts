import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { SiteDeployState } from './site-deploy-guard.ts'

// Mutation checks run the same assertions against disposable source copies.
const script =
  process.env.HOURMERE_SITE_DEPLOY_GUARD_SCRIPT ??
  fileURLToPath(new URL('./site-deploy-guard.ts', import.meta.url))
const { readSiteDeployState, siteDeployRefusal } = await import(pathToFileURL(script).href)
const manifest =
  process.env.HOURMERE_SITE_DEPLOY_MANIFEST ??
  fileURLToPath(new URL('../apps/site/package.json', import.meta.url))
const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const head = 'a'.repeat(40)
const other = 'b'.repeat(40)
const fetchCommand = "git fetch origin --tags --prune '+refs/heads/*:refs/remotes/origin/*'"
const state = (overrides: Partial<SiteDeployState> = {}): SiteDeployState => {
  const local = {
    branch: 'main',
    head,
    upstreamSha: head,
    originMainSha: head,
    originSiteLiveSha: null,
    tags: [],
    dirty: false,
    ...overrides,
  }
  return {
    ...local,
    remoteRefs: {
      mainSha: local.originMainSha,
      siteLiveSha: local.originSiteLiveSha,
      tags: local.tags,
    },
    ...overrides,
  }
}
const live = (overrides: Partial<SiteDeployState> = {}) =>
  state({
    branch: 'site-live',
    originSiteLiveSha: head,
    tags: [{ name: 'v1.0.0', sha: head, reachable: true }],
    ...overrides,
  })

describe('website deploy decisions', () => {
  it('allows clean, synchronized main before site-live exists, even with release tags', () => {
    expect(siteDeployRefusal(state())).toBeNull()
    expect(
      siteDeployRefusal(state({ tags: [{ name: 'v1.0.0', sha: head, reachable: false }] })),
    ).toBeNull()
  })

  it('fails closed when origin cannot be inspected', () => {
    expect(siteDeployRefusal(state({ remoteRefs: null }))).toBe(
      `Cannot inspect origin; run ${fetchCommand} successfully and retry.`,
    )
  })

  it.each([
    ['main advanced or changed', { mainSha: other, siteLiveSha: null, tags: [] }],
    ['main was deleted', { mainSha: null, siteLiveSha: null, tags: [] }],
    ['site-live is unknown locally', { mainSha: head, siteLiveSha: other, tags: [] }],
  ])('refuses stale fetched refs when %s', (_reason, remoteRefs) => {
    expect(siteDeployRefusal(state({ remoteRefs }))).toBe(
      `Local origin branches or stable tags differ from origin; run ${fetchCommand} and retry.`,
    )
  })

  it.each([other, null])('refuses changed or deleted remote site-live (%s)', (siteLiveSha) => {
    expect(
      siteDeployRefusal(live({ remoteRefs: { mainSha: head, siteLiveSha, tags: [] } })),
    ).toContain(fetchCommand)
  })

  it.each([{ tags: [] }, { tags: [{ name: 'v1.0.0', sha: other, reachable: true }] }])(
    'refuses stable tags missing or different locally (%j)',
    ({ tags }) => {
      expect(
        siteDeployRefusal(
          state({
            tags,
            remoteRefs: {
              mainSha: head,
              siteLiveSha: null,
              tags: [{ name: 'v1.0.0', sha: head }],
            },
          }),
        ),
      ).toContain(fetchCommand)
    },
  )

  it('ignores remote prereleases and nonstable tag names', () => {
    expect(
      siteDeployRefusal(
        state({
          remoteRefs: {
            mainSha: head,
            siteLiveSha: null,
            tags: ['v2.0.0-rc.1', 'v2.0.0+build', 'v02.0.0', 'v2.0'].map((name) => ({
              name,
              sha: other,
            })),
          },
        }),
      ),
    ).toBeNull()
  })

  it('allows synchronized site-live containing the latest stable release and later corrections', () => {
    expect(siteDeployRefusal(live())).toBeNull()
    expect(
      siteDeployRefusal(
        live({
          tags: [
            { name: 'v1.0.0', sha: head, reachable: true },
            { name: 'v1.1.0', sha: head, reachable: true },
            { name: 'v2.0.0-rc.1', sha: head, reachable: false },
          ],
        }),
      ),
    ).toBeNull()
  })

  it.each([state(), live()])('refuses dirty worktrees in either phase (%j)', (clean) => {
    expect(siteDeployRefusal({ ...clean, dirty: true })).toContain('Worktree is dirty; commit')
  })

  it.each([null, 'feature', 'site-live'])('requires main before the cut (branch=%s)', (branch) => {
    expect(siteDeployRefusal(state({ branch }))).toBe('Switch to the main branch before deploying.')
  })

  it.each([null, 'feature', 'main'])('requires site-live after the cut (branch=%s)', (branch) => {
    expect(siteDeployRefusal(live({ branch }))).toBe(
      'Switch to the site-live branch before deploying.',
    )
  })

  it.each([state(), live()])('requires an upstream (%j)', (clean) => {
    expect(siteDeployRefusal({ ...clean, upstreamSha: null })).toContain('Set the branch upstream')
  })

  it.each([state(), live()])('requires HEAD to equal its upstream (%j)', (clean) => {
    expect(siteDeployRefusal({ ...clean, upstreamSha: other })).toContain(
      'HEAD differs from its upstream',
    )
  })

  it('requires origin/main to exist', () => {
    expect(siteDeployRefusal(state({ originMainSha: null }))).toContain(
      'origin/main is missing; fetch',
    )
  })

  it('checks origin/main even if another upstream matches HEAD', () => {
    expect(siteDeployRefusal(state({ originMainSha: other }))).toContain(
      'HEAD differs from origin/main',
    )
  })

  it('checks origin/site-live even if another upstream matches HEAD', () => {
    expect(siteDeployRefusal(live({ originSiteLiveSha: other }))).toContain(
      'HEAD differs from origin/site-live',
    )
  })

  it('requires a stable tag after the cut', () => {
    expect(siteDeployRefusal(live({ tags: [] }))).toContain('No stable release tag')
  })

  it.each([
    ['v1.9.9', 'v1.10.0'],
    ['v1.10.0', 'v2.0.0'],
    ['v2.0.9', 'v2.0.10'],
  ])('requires the numeric highest stable tag (%s < %s), naming it', (older, latest) => {
    const tags = [
      { name: older, sha: head, reachable: true },
      { name: latest, sha: other, reachable: false },
    ]
    for (const list of [tags, [...tags].reverse()]) {
      expect(siteDeployRefusal(live({ tags: list }))).toBe(
        `HEAD is missing ${latest}; merge ${latest} into site-live and push before deploying.`,
      )
    }
  })

  it('ignores prereleases and tags outside the stable release naming scheme', () => {
    const tags = [
      'v9.0.0-rc.1',
      'v9.0.0-beta',
      'v9.0.0+build.1',
      'v09.0.0',
      '9.0.0',
      'v9.0',
      'other',
    ].map((name) => ({ name, sha: other, reachable: false }))
    expect(
      siteDeployRefusal(live({ tags: [...tags, { name: 'v1.0.0', sha: head, reachable: true }] })),
    ).toBeNull()
    expect(siteDeployRefusal(live({ tags }))).toContain('No stable release tag')
  })
})

function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'hourmere-site-deploy-guard-'))
  scratch.push(dir)
  return dir
}

// Scratch Git commands never read the user's Git configuration or run hooks.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Deploy Guard Test',
  GIT_AUTHOR_EMAIL: 'deploy-guard@example.com',
  GIT_COMMITTER_NAME: 'Deploy Guard Test',
  GIT_COMMITTER_EMAIL: 'deploy-guard@example.com',
}

function fixture() {
  const dir = directory()
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: dir,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  git('init', '--quiet', '--initial-branch=main')
  mkdirSync(join(dir, 'apps/site'), { recursive: true })
  writeFileSync(join(dir, '.gitignore'), 'dist/\n')
  writeFileSync(join(dir, 'apps/site/page.txt'), 'Released page\n')
  git('add', '.')
  git('commit', '--quiet', '--message=Start')
  const first = git('rev-parse', 'HEAD')
  // A private local bare remote exercises ls-remote without network access.
  const origin = join(directory(), 'origin.git')
  git('init', '--quiet', '--bare', '--initial-branch=main', origin)
  git('remote', 'add', 'origin', origin)
  git('push', '--quiet', 'origin', 'main')
  git('branch', '--set-upstream-to=origin/main', 'main')
  const run = (cwd = join(dir, 'apps/site')) =>
    spawnSync(process.execPath, [script], { cwd, env, encoding: 'utf8' })
  const commit = () => {
    git('commit', '--quiet', '--allow-empty', '--message=Update')
    return git('rev-parse', 'HEAD')
  }
  const synchronize = (branch: string) => {
    git('push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`, '--tags')
    git('branch', `--set-upstream-to=origin/${branch}`, branch)
  }
  const cut = () => {
    git('tag', '--annotate', 'v1.0.0', '--message=Release 1.0.0')
    git('switch', '--quiet', '--create', 'site-live')
    synchronize('site-live')
  }
  return { dir, git, origin, first, run, commit, synchronize, cut }
}

describe('website deploy Git wrapper', () => {
  it('passes from apps/site and a separate main worktree with a .git file', () => {
    const repo = fixture()
    expect(repo.run().status).toBe(0)
    repo.git('switch', '--quiet', '--create', 'development')
    const worktree = join(directory(), 'main-worktree')
    repo.git('worktree', 'add', '--quiet', worktree, 'main')
    expect(readFileSync(join(worktree, '.git'), 'utf8')).toMatch(/^gitdir: /)
    const result = repo.run(join(worktree, 'apps/site'))
    expect(result.status, result.stderr).toBe(0)
  })

  it.each(['staged', 'unstaged', 'untracked', 'outside site'])('refuses %s changes', (kind) => {
    const repo = fixture()
    const path =
      kind === 'outside site'
        ? 'root-source.txt'
        : kind === 'untracked'
          ? 'apps/site/new.txt'
          : 'apps/site/page.txt'
    writeFileSync(join(repo.dir, path), 'Unpublished change\n')
    if (kind === 'staged') repo.git('add', path)
    const result = repo.run()
    expect(result.status).toBe(1)
    expect(result.stderr.trim()).toBe(
      'site-deploy-guard: Worktree is dirty; commit or remove local changes before deploying.',
    )
  })

  it('allows ignored build output that is regenerated by the existing build', () => {
    const repo = fixture()
    mkdirSync(join(repo.dir, 'apps/site/dist'))
    writeFileSync(join(repo.dir, 'apps/site/dist/index.html'), 'Old output\n')
    expect(repo.run().status).toBe(0)
  })

  it.each(['public/debug.log', 'src/pages/unreleased.astro', 'worker/unreleased.ts'])(
    'refuses ignored build inputs that could ship (%s)',
    (path) => {
      const repo = fixture()
      writeFileSync(join(repo.dir, '.git/info/exclude'), `apps/site/${path}\n`)
      const directory = path.split('/').slice(0, -1).join('/')
      mkdirSync(join(repo.dir, 'apps/site', directory), { recursive: true })
      writeFileSync(join(repo.dir, 'apps/site', path), 'Unpublished content\n')
      expect(repo.git('status', '--porcelain')).toBe('')
      const result = repo.run()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Worktree is dirty')
    },
  )

  it('refuses a detached HEAD, an unset upstream and a deleted upstream ref', () => {
    const repo = fixture()
    repo.git('switch', '--quiet', '--detach')
    expect(repo.run().stderr).toContain('Switch to the main branch')
    repo.git('switch', '--quiet', 'main')
    repo.git('branch', '--unset-upstream')
    expect(repo.run().stderr).toContain('Set the branch upstream')
    repo.synchronize('main')
    repo.git('update-ref', '-d', 'refs/remotes/origin/main')
    expect(repo.run().stderr).toContain(fetchCommand)
  })

  it.each(['main', 'site-live'])(
    'refuses remote %s changes that have not been fetched',
    (branch) => {
      const repo = fixture()
      if (branch === 'site-live') repo.cut()
      const before = repo.git('rev-parse', 'HEAD')
      const next = repo.commit()
      repo.git('push', '--quiet', 'origin', 'HEAD:refs/heads/remote-update')
      repo.git('reset', '--quiet', '--hard', before)
      repo.git('--git-dir', repo.origin, 'update-ref', `refs/heads/${branch}`, next)
      const result = repo.run()
      expect(result.status).toBe(1)
      expect(result.stderr.trim()).toBe(
        `site-deploy-guard: Local origin branches or stable tags differ from origin; run ${fetchCommand} and retry.`,
      )
      expect(repo.git('rev-parse', `refs/remotes/origin/${branch}`)).toBe(before)
    },
  )

  it('refuses main when site-live exists remotely but is unknown locally', () => {
    const repo = fixture()
    repo.git('--git-dir', repo.origin, 'update-ref', 'refs/heads/site-live', repo.first)
    const inspected = readSiteDeployState(repo.dir)
    expect(inspected.originSiteLiveSha).toBeNull()
    expect(inspected.remoteRefs?.siteLiveSha).toBe(repo.first)
    const result = repo.run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(fetchCommand)
  })

  it.each(['annotated', 'lightweight'])(
    'refuses a stable %s tag missing locally, then permits after the documented fetch',
    (kind) => {
      const repo = fixture()
      if (kind === 'annotated') {
        repo.git('tag', '--annotate', 'v1.0.0', '--message=Release 1.0.0')
      } else {
        repo.git('tag', 'v1.0.0')
      }
      repo.git('push', '--quiet', 'origin', '--tags')
      repo.git('tag', '--delete', 'v1.0.0')
      const inspected = readSiteDeployState(repo.dir)
      expect(inspected.remoteRefs?.tags).toEqual([{ name: 'v1.0.0', sha: repo.first }])
      expect(repo.run().status).toBe(1)
      expect(repo.run().stderr).toContain(fetchCommand)
      repo.git('fetch', 'origin', '--tags', '--prune', '+refs/heads/*:refs/remotes/origin/*')
      const result = repo.run()
      expect(result.status, result.stderr).toBe(0)
    },
  )

  it('refuses a local stable tag pointing to a different commit than origin', () => {
    const repo = fixture()
    repo.git('tag', 'v1.0.0')
    repo.git('push', '--quiet', 'origin', '--tags')
    repo.commit()
    repo.git('tag', '--force', 'v1.0.0')
    repo.git('reset', '--quiet', '--hard', repo.first)
    expect(repo.run().status).toBe(1)
    expect(repo.run().stderr).toContain(fetchCommand)
  })

  it('allows a remote prerelease tag that has not been fetched', () => {
    const repo = fixture()
    repo.git('tag', 'v2.0.0-rc.1')
    repo.git('push', '--quiet', 'origin', '--tags')
    repo.git('tag', '--delete', 'v2.0.0-rc.1')
    expect(repo.run().status).toBe(0)
  })

  it('fails closed on ls-remote errors with one actionable line', () => {
    const repo = fixture()
    repo.git('remote', 'set-url', 'origin', join(repo.dir, 'unavailable-origin'))
    expect(readSiteDeployState(repo.dir).remoteRefs).toBeNull()
    const result = repo.run()
    expect(result.status).toBe(1)
    expect(result.stderr.trim().split('\n')).toHaveLength(1)
    expect(result.stderr.trim()).toBe(
      `site-deploy-guard: Cannot inspect origin; run ${fetchCommand} successfully and retry.`,
    )
  })

  it.each(['ahead', 'behind', 'diverged'])(
    'refuses HEAD %s of its fetched upstream',
    (position) => {
      const repo = fixture()
      repo.commit()
      if (position !== 'ahead') {
        repo.synchronize('main')
        repo.git('reset', '--quiet', '--hard', repo.first)
        if (position === 'diverged') {
          writeFileSync(join(repo.dir, 'apps/site/page.txt'), 'Different history\n')
          repo.git('add', '.')
          repo.commit()
        }
      }
      const result = repo.run()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('HEAD differs from its upstream')
    },
  )

  it('switches to site-live policy as soon as its origin ref exists', () => {
    const repo = fixture()
    repo.cut()
    repo.git('switch', '--quiet', 'main')
    expect(repo.run().status).toBe(1)
    expect(repo.run().stderr).toContain('Switch to the site-live branch')
  })

  it('reads annotated/lightweight stable tags and requires the highest release to be merged', () => {
    const repo = fixture()
    repo.cut()
    repo.commit()
    repo.synchronize('site-live')
    expect(repo.run().status).toBe(0)
    repo.git('switch', '--quiet', 'main')
    writeFileSync(join(repo.dir, 'apps/site/page.txt'), 'Next release\n')
    repo.git('add', '.')
    repo.commit()
    repo.git('tag', 'v1.10.0')
    repo.git('tag', 'v9.0.0-rc.1')
    repo.git('switch', '--quiet', 'site-live')
    const failed = repo.run()
    expect(failed.status).toBe(1)
    expect(failed.stderr.trim()).toBe(
      'site-deploy-guard: HEAD is missing v1.10.0; merge v1.10.0 into site-live and push before deploying.',
    )
    repo.git('merge', '--quiet', '--no-edit', 'v1.10.0')
    repo.synchronize('site-live')
    expect(repo.run().status).toBe(0)
    expect(readSiteDeployState(repo.dir).tags).toContainEqual({
      name: 'v1.10.0',
      sha: repo.git('rev-parse', 'v1.10.0'),
      reachable: true,
    })
  })

  it('fails closed on Git errors and emits a single actionable line', () => {
    const dir = directory()
    const result = spawnSync(process.execPath, [script], { cwd: dir, env, encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr.trim().split('\n')).toHaveLength(1)
    expect(result.stderr).toContain('Cannot inspect Git state; use a complete Git checkout')
  })
})

describe('site deploy command', () => {
  it('runs the guard before the unchanged build and pinned Wrangler, stopping on refusal', () => {
    const { scripts } = JSON.parse(readFileSync(manifest, 'utf8'))
    expect(scripts.build).toBe('astro build')
    expect(scripts.deploy).toBe(
      'node ../../scripts/site-deploy-guard.ts && npm run build && npx --yes wrangler@4.151.0 deploy --env=""',
    )
    const dir = directory()
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const marker = join(dir, 'build-or-publish-called')
    writeFileSync(join(bin, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    for (const command of ['npm', 'npx']) {
      writeFileSync(join(bin, command), '#!/bin/sh\n: > "$DEPLOY_TEST_MARKER"\n', { mode: 0o755 })
    }
    const result = spawnSync('/bin/sh', ['-c', scripts.deploy], {
      cwd: dir,
      env: { ...env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_TEST_MARKER: marker },
    })
    expect(result.status).toBe(1)
    expect(existsSync(marker)).toBe(false)
  })
})
