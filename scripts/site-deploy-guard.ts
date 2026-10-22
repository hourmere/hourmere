import { execFileSync, spawnSync } from 'node:child_process'

export interface SiteDeployState {
  branch: string | null
  head: string
  upstreamSha: string | null
  originMainSha: string | null
  // A null SHA means the fetched origin/site-live ref does not exist yet.
  originSiteLiveSha: string | null
  tags: readonly { name: string; sha: string; reachable: boolean }[]
  // Null means origin could not be inspected, so publication must fail closed.
  remoteRefs: {
    mainSha: string | null
    siteLiveSha: string | null
    tags: readonly { name: string; sha: string }[]
  } | null
  dirty: boolean
}

function stableVersion(name: string): bigint[] | undefined {
  // Match the release workflow's stable tags: no prerelease or build metadata.
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(name)
  return match?.slice(1).map((part) => BigInt(part))
}

const fetchCommand = "git fetch origin --tags --prune '+refs/heads/*:refs/remotes/origin/*'"

/** A refusal with the next operator action, or null when publication is allowed. */
export function siteDeployRefusal(state: SiteDeployState): string | null {
  if (state.dirty) return 'Worktree is dirty; commit or remove local changes before deploying.'

  if (state.remoteRefs === null) {
    return `Cannot inspect origin; run ${fetchCommand} successfully and retry.`
  }
  if (
    state.originMainSha !== state.remoteRefs.mainSha ||
    state.originSiteLiveSha !== state.remoteRefs.siteLiveSha ||
    state.remoteRefs.tags.some(
      (remote) =>
        stableVersion(remote.name) &&
        !state.tags.some((local) => local.name === remote.name && local.sha === remote.sha),
    )
  ) {
    return `Local origin branches or stable tags differ from origin; run ${fetchCommand} and retry.`
  }

  const branch = state.originSiteLiveSha === null ? 'main' : 'site-live'
  if (state.branch !== branch) return `Switch to the ${branch} branch before deploying.`
  if (state.upstreamSha === null) {
    return `Set the branch upstream to origin/${branch}, fetch origin, and retry.`
  }
  if (state.head !== state.upstreamSha) {
    return 'HEAD differs from its upstream; fetch, reconcile and push the branch before deploying.'
  }

  const originSha = branch === 'main' ? state.originMainSha : state.originSiteLiveSha
  if (originSha === null) return `origin/${branch} is missing; fetch origin and retry.`
  if (state.head !== originSha) {
    return `HEAD differs from origin/${branch}; reconcile and push ${branch} before deploying.`
  }
  if (branch === 'main') return null

  const stableTags = state.tags.flatMap((tag) => {
    const version = stableVersion(tag.name)
    return version ? [{ ...tag, version }] : []
  })
  stableTags.sort((a, b) => {
    for (let i = 0; i < 3; i++) {
      const left = a.version[i] ?? 0n
      const right = b.version[i] ?? 0n
      if (left !== right) return left > right ? -1 : 1
    }
    return 0
  })
  const latest = stableTags[0]
  if (!latest) return 'No stable release tag is available; fetch origin tags before deploying.'
  if (!latest.reachable) {
    return `HEAD is missing ${latest.name}; merge ${latest.name} into site-live and push before deploying.`
  }
  return null
}

/** Inspect local state and origin without changing refs; fetching remains an operator action. */
export function readSiteDeployState(cwd = process.cwd()): SiteDeployState {
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  const symbolic = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (symbolic.error || (symbolic.status !== 0 && symbolic.status !== 1)) {
    throw new Error('Cannot read the current branch')
  }
  const branch = symbolic.status === 0 ? symbolic.stdout.trim() : null
  const refs = new Map(
    git(
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(upstream)',
      'refs/heads/',
      'refs/remotes/',
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name = '', sha = '', upstream = ''] = line.split('\0')
        return [name, { sha, upstream }] as const
      }),
  )
  const upstream = branch === null ? undefined : refs.get(`refs/heads/${branch}`)?.upstream
  const reachable = new Set(git('tag', '--merged', 'HEAD').split('\n'))
  const remote = spawnSync(
    'git',
    ['ls-remote', 'origin', 'refs/heads/main', 'refs/heads/site-live', 'refs/tags/v*'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const remoteRefs = new Map(
    remote.stdout
      ?.trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha = '', name = ''] = line.split('\t')
        return [name, sha] as const
      }),
  )
  return {
    branch,
    head: git('rev-parse', '--verify', 'HEAD'),
    upstreamSha: upstream ? (refs.get(upstream)?.sha ?? null) : null,
    originMainSha: refs.get('refs/remotes/origin/main')?.sha ?? null,
    originSiteLiveSha: refs.get('refs/remotes/origin/site-live')?.sha ?? null,
    tags: git(
      'for-each-ref',
      '--format=%(refname:strip=2)%00%(objectname)%00%(*objectname)',
      'refs/tags/',
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name = '', object = '', peeled = ''] = line.split('\0')
        return { name, sha: peeled || object, reachable: reachable.has(name) }
      }),
    remoteRefs:
      remote.error || remote.status !== 0
        ? null
        : {
            mainSha: remoteRefs.get('refs/heads/main') ?? null,
            siteLiveSha: remoteRefs.get('refs/heads/site-live') ?? null,
            tags: [...remoteRefs].flatMap(([ref, sha]) => {
              const name = ref.slice('refs/tags/'.length)
              if (!ref.startsWith('refs/tags/') || !stableVersion(name)) return []
              return [{ name, sha: remoteRefs.get(`${ref}^{}`) ?? sha }]
            }),
          },
    // Check the entire repository, including from apps/site or a linked worktree.
    dirty:
      git('status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none') !== '' ||
      // Ignore rules must not hide Astro inputs or Worker source Wrangler publishes.
      git(
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--',
        ':(top)apps/site/src',
        ':(top)apps/site/public',
        ':(top)apps/site/worker',
      ) !== '',
  }
}

if (import.meta.main) {
  try {
    const refusal = siteDeployRefusal(readSiteDeployState())
    if (refusal) {
      console.error(`site-deploy-guard: ${refusal}`)
      process.exitCode = 1
    }
  } catch {
    console.error(
      'site-deploy-guard: Cannot inspect Git state; use a complete Git checkout, fetch origin branches and tags, and retry.',
    )
    process.exitCode = 1
  }
}
