// Read-only release preparation. Publication lives in the protected workflow job.
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function versionFromTag(tag: string) {
  // Build metadata (+...) cannot be represented verbatim by a Docker tag. Reject it
  // rather than silently map two distinct SemVer versions to the same image tag.
  const match =
    /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag)
  const identifiers = match?.[4]?.split('.') ?? []
  if (
    !match ||
    tag.length > 129 ||
    identifiers.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))
  ) {
    throw new Error(
      'Expected vMAJOR.MINOR.PATCH with optional SemVer prerelease; no build metadata',
    )
  }
  return {
    version: tag.slice(1),
    major_minor: `${match[1]}.${match[2]}`,
    prerelease: identifiers.length > 0,
  }
}

function releaseNotes(changelog: string, version: string): string {
  const lines = changelog.replaceAll('\r\n', '\n').split('\n')
  const matches: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i] ?? ''
    const dated = /^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}$/.exec(heading)
    if (dated?.[1] !== version && heading !== `## [Unreleased → ${version}]`) continue
    const end = lines.findIndex((line, index) => index > i && line.startsWith('## '))
    matches.push(
      lines
        .slice(i + 1, end === -1 ? undefined : end)
        .join('\n')
        .trim(),
    )
  }
  if (matches.length !== 1 || !matches[0]) {
    throw new Error('CHANGELOG must contain exactly one nonempty section matching the tag version')
  }
  return `${matches[0]}\n`.replaceAll(
    'https://github.com/hourmere/hourmere/blob/main/',
    `https://github.com/hourmere/hourmere/blob/v${version}/`,
  )
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function prepare(tag: string, sha: string) {
  const version = versionFromTag(tag)
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Expected the full tagged commit SHA')
  const tagged = git('rev-parse', '--verify', '--end-of-options', `refs/tags/${tag}^{commit}`)
  if (tagged !== sha || git('rev-parse', 'HEAD') !== sha) {
    throw new Error('Tag, event SHA and checked-out commit must agree')
  }
  const ancestry = spawnSync('git', [
    'merge-base',
    '--is-ancestor',
    sha,
    'refs/remotes/origin/main',
  ])
  if (ancestry.status !== 0) throw new Error('The tagged commit must be on origin/main')
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: unknown }
  if (manifest.version !== version.version) {
    throw new Error('The tag version must match the root package.json version')
  }
  const notes = releaseNotes(readFileSync('CHANGELOG.md', 'utf8'), version.version)
  const runnerTemp = process.env.RUNNER_TEMP
  const output = process.env.GITHUB_OUTPUT
  if (!runnerTemp || !output) throw new Error('RUNNER_TEMP and GITHUB_OUTPUT are required')
  const notesFile = join(runnerTemp, 'hourmere-release-notes.md')
  writeFileSync(notesFile, notes)
  appendFileSync(
    output,
    `version=${version.version}\nmajor_minor=${version.major_minor}\nprerelease=${version.prerelease}\nnotes_file=${notesFile}\n`,
  )
}

function checkEnvironment(file: string) {
  const environment = JSON.parse(readFileSync(file, 'utf8')) as {
    protection_rules?: Array<{
      type?: string
      reviewers?: Array<{ type?: string; reviewer?: { id?: number } }>
    }>
  }
  const approved = environment.protection_rules?.some(
    (rule) =>
      rule.type === 'required_reviewers' &&
      rule.reviewers?.some(
        ({ type, reviewer }) =>
          (type === 'User' || type === 'Team') &&
          Number.isSafeInteger(reviewer?.id) &&
          (reviewer?.id ?? 0) > 0,
      ),
  )
  if (!approved) {
    throw new Error('The release environment needs required owner reviewers')
  }
}

function main(args: string[]) {
  const [command, first, second] = args
  if (command === 'prepare' && args.length === 3 && first && second) prepare(first, second)
  else if (command === 'check-environment' && args.length === 2 && first) checkEnvironment(first)
  else throw new Error('Usage: release.ts prepare <tag> <sha> | check-environment <json-file>')
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2))
  } catch {
    // Git/API files are not printed: they may contain runner-specific or untrusted text.
    console.error(
      'Release preparation failed; check the tag, package version, main ancestry, notes and owner approval configuration.',
    )
    process.exitCode = 1
  }
}
