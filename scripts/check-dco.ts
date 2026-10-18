// Checks that every commit in a pull request carries a Developer Certificate of Origin
// sign-off, as CONTRIBUTING.md#license-and-sign-off requires. CI runs it from
// .github/workflows/dco.yml; it also runs locally:
//
//   node scripts/check-dco.ts [--no-exemptions] <base> <head>
//
// It checks the commits in <base>..<head> and exits 0 when they all pass, 1 when any needs a
// sign-off, and 2 on a usage or git error. --no-exemptions checks exempt authors too (CI uses
// it for pull requests from forks).
//
// Names, email addresses and messages in commits are untrusted text. git runs without a shell
// with its arguments passed as an array, and everything printed has control characters
// escaped, so a commit cannot add lines (or GitHub Actions workflow commands) to the output.

import { execFileSync, spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'

/**
 * Authors whose commits need no sign-off, by the commit's author email (compared ignoring
 * case): the maintainer, whose identity Cobaltmere's AI coding agents also commit under, and
 * Dependabot. That code is Cobaltmere's own work, so no outside contribution needs certifying.
 * Keep CONTRIBUTING.md#license-and-sign-off in step with this list.
 */
export const EXEMPT_AUTHOR_EMAILS: readonly string[] = [
  // The maintainer, committing locally.
  'adrian@cobaltmere.com',
  // The maintainer's GitHub account (adrian-lee-dev), on commits made in GitHub's web UI.
  '167077805+adrian-lee-dev@users.noreply.github.com',
  // Dependabot.
  '49699333+dependabot[bot]@users.noreply.github.com',
]

export interface Commit {
  sha: string
  parents: string[]
  /** Exactly two parents, merged without conflicts to this commit's tree. */
  cleanMerge: boolean
  authorName: string
  authorEmail: string
  subject: string
  /** Values of the Signed-off-by trailers, found by git's own trailer rules. */
  signOffs: string[]
}

export type Result =
  | { status: 'signed' | 'exempt' | 'merge' }
  | {
      status: 'missing'
      problem: string
      /** The author is on the exempt list, but exemptions were off (a pull request from a fork). */
      authorExempt: boolean
    }

const CONTRIBUTING_URL =
  'https://github.com/cobaltmere/hourmere/blob/main/CONTRIBUTING.md#license-and-sign-off'

function git(cwd: string | undefined, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim()
    throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`)
  }
}

function resolveCommit(cwd: string | undefined, rev: string): string {
  try {
    return git(cwd, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${rev}^{commit}`,
    ]).trim()
  } catch {
    throw new Error(
      `${rev} is not a commit in this repository (a CI checkout needs fetch-depth: 0)`,
    )
  }
}

// Fields are separated by NUL, which git does not allow in names or commit messages. The
// trailers come last, one value per field, unfolded onto one line each.
const FORMAT =
  '%T%x00%P%x00%an%x00%ae%x00%s%x00%(trailers:key=Signed-off-by,valueonly,unfold,separator=%x00)'

function isCleanMerge(cwd: string | undefined, parents: string[], tree: string): boolean {
  // Octopus merges require a sign-off: a two-parent automatic merge cannot verify them.
  if (parents.length !== 2) return false
  const merged = spawnSync('git', ['merge-tree', '--write-tree', ...parents], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
  // A synthetic merge may join unrelated histories. Git cannot verify it with the ordinary
  // automatic merge, so require its author's sign-off rather than reject signed work.
  if (merged.status === 128 && merged.stderr.includes('refusing to merge unrelated histories')) {
    return false
  }
  // merge-tree exits 1 for conflicts, and still prints a tree (with conflict markers).
  // Neither that tree nor a tree containing manual resolutions qualifies as a clean merge.
  if (merged.error || (merged.status !== 0 && merged.status !== 1)) {
    throw new Error(`git merge-tree failed: ${merged.error?.message ?? merged.stderr.trim()}`)
  }
  return merged.status === 0 && merged.stdout.split('\n')[0] === tree
}

/** The commits in base..head, oldest first. */
export function readCommits(base: string, head: string, cwd?: string): Commit[] {
  const range = `${resolveCommit(cwd, base)}..${resolveCommit(cwd, head)}`
  const shas = git(cwd, ['rev-list', '--reverse', range]).split('\n').filter(Boolean)
  return shas.map((sha) => {
    const out = git(cwd, ['show', '--no-show-signature', '-s', `--format=${FORMAT}`, sha])
    const [
      tree = '',
      parentText = '',
      authorName = '',
      authorEmail = '',
      subject = '',
      ...signOffs
    ] = out.replace(/\n$/, '').split('\0')
    const parents = parentText.split(' ').filter(Boolean)
    return {
      sha,
      parents,
      cleanMerge: isCleanMerge(cwd, parents, tree),
      authorName,
      authorEmail,
      subject,
      signOffs: signOffs.filter(Boolean),
    }
  })
}

const normalize = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase()

/** Whether a Signed-off-by value ("Name <email>") names the commit's author. */
function namesAuthor(signOff: string, commit: Commit): boolean {
  const match = /^(.*?)\s*<([^<>]*)>$/.exec(signOff.trim())
  if (!match) return false
  const [, name = '', email = ''] = match
  return (
    normalize(name) === normalize(commit.authorName) &&
    normalize(email) === normalize(commit.authorEmail)
  )
}

export function checkCommit(commit: Commit, options: { honorExemptions: boolean }): Result {
  // Only a conflict-free automatic merge adds no work needing its own sign-off. Every
  // introduced commit is also checked; manual resolutions and extra merge content are not
  // represented by those commits, so they follow the ordinary author/sign-off rules below.
  if (commit.cleanMerge) return { status: 'merge' }

  const exempt = EXEMPT_AUTHOR_EMAILS.includes(commit.authorEmail.toLowerCase())
  if (exempt && options.honorExemptions) return { status: 'exempt' }
  if (commit.signOffs.some((signOff) => namesAuthor(signOff, commit))) return { status: 'signed' }

  const problem =
    commit.signOffs.length === 0
      ? 'no Signed-off-by trailer (it must be in the last paragraph of the message)'
      : `Signed-off-by does not name the author: ${commit.signOffs.join(', ')}`
  return { status: 'missing', problem, authorExempt: exempt }
}

/** Escapes control/format characters and the legacy GitHub Actions command prefix. */
export function displayText(text: string): string {
  return (
    text
      .replace(
        /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
        (char) => `\\u{${char.codePointAt(0)?.toString(16)}}`,
      )
      // Unlike ::command::, the runner recognizes ##[command] anywhere in a line.
      .replaceAll('##[', '\\u{23}#[')
  )
}

const LABELS = { signed: 'ok', exempt: 'exempt', merge: 'merge', missing: 'MISSING' } as const

/** The report printed for a range: one line per commit, then what is wrong and how to fix it. */
export function formatReport(
  range: string,
  checked: Array<{ commit: Commit; result: Result }>,
): string {
  // Our prefix prevents ::command:: at line start; displayText escapes legacy commands.
  const lines = [`DCO sign-off check of ${checked.length} commit(s) in ${displayText(range)}:`]
  for (const { commit, result } of checked) {
    const label = LABELS[result.status].padEnd(8)
    lines.push(`  ${label} ${commit.sha.slice(0, 7)}  ${displayText(commit.subject)}`)
  }

  const failed = checked.flatMap(({ commit, result }) =>
    result.status === 'missing' ? [{ commit, result }] : [],
  )
  if (failed.length === 0) {
    lines.push('', 'Every commit is signed off, exempt or a clean merge.')
    return lines.join('\n')
  }

  lines.push('', `${failed.length} commit(s) need a sign-off:`)
  for (const { commit, result } of failed) {
    const author = displayText(`${commit.authorName} <${commit.authorEmail}>`)
    lines.push(
      '',
      `  ${commit.sha.slice(0, 7)}  ${displayText(commit.subject)}`,
      `    author:   ${author}`,
      `    problem:  ${displayText(result.problem)}`,
      `    expected: Signed-off-by: ${author}`,
    )
  }
  if (failed.some(({ result }) => result.authorExempt)) {
    lines.push(
      '',
      "Exemptions are off for pull requests from forks: anyone can set a commit's author email,",
      'so every commit in them needs a sign-off, whoever its author is.',
    )
  }
  lines.push(
    '',
    'Each commit from an external contributor needs a Signed-off-by trailer naming its author,',
    'certifying the Developer Certificate of Origin (https://developercertificate.org/).',
    'git signs off with your user.name and user.email, so they must match the author. To fix:',
    '',
    '  git commit --amend --signoff --no-edit   # the last commit',
    '  git rebase --signoff <base>              # every commit; <base> is the branch you',
    '                                           # started from, e.g. origin/main',
    '  git push --force-with-lease',
    '',
    `See ${CONTRIBUTING_URL}`,
  )
  return lines.join('\n')
}

const USAGE = 'usage: node scripts/check-dco.ts [--no-exemptions] <base> <head>'

function main(argv: string[]): number {
  let args: { values: { 'no-exemptions'?: boolean }; positionals: string[] }
  try {
    args = parseArgs({
      args: argv,
      options: { 'no-exemptions': { type: 'boolean' } },
      allowPositionals: true,
    })
  } catch (error) {
    console.error(`${displayText((error as Error).message)}\n${USAGE}`)
    return 2
  }
  const [base, head] = args.positionals
  if (args.positionals.length !== 2 || base === undefined || head === undefined) {
    console.error(USAGE)
    return 2
  }

  let commits: Commit[]
  try {
    commits = readCommits(base, head)
  } catch (error) {
    console.error(`check-dco: ${displayText((error as Error).message)}`)
    return 2
  }
  const honorExemptions = !args.values['no-exemptions']
  const checked = commits.map((commit) => ({
    commit,
    result: checkCommit(commit, { honorExemptions }),
  }))
  console.log(formatReport(`${base}..${head}`, checked))
  return checked.some(({ result }) => result.status === 'missing') ? 1 : 0
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
