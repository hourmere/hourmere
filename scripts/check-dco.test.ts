import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type Commit,
  checkCommit,
  displayText,
  EXEMPT_AUTHOR_EMAILS,
  formatReport,
  readCommits,
} from './check-dco.ts'

interface Person {
  name: string
  email: string
}

const jane: Person = { name: 'Jane Doe', email: 'jane@example.com' }
const maintainer: Person = { name: 'Adrian Lee', email: 'adrian@cobaltmere.com' }
// What GitHub puts on a commit the maintainer makes in its web UI.
const maintainerOnGitHub: Person = {
  name: 'adrian-lee-dev',
  email: '167077805+adrian-lee-dev@users.noreply.github.com',
}
const dependabot: Person = {
  name: 'dependabot[bot]',
  email: '49699333+dependabot[bot]@users.noreply.github.com',
}
const signOff = (who: Person) => `Signed-off-by: ${who.name} <${who.email}>`

const opts = { honorExemptions: true }
const script = fileURLToPath(new URL('./check-dco.ts', import.meta.url))
const dirs: string[] = []

beforeAll(() => {
  // Keep the scratch repositories away from the developer's git config and from any
  // repository named by the environment (as in a git hook).
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('GIT_')) vi.stubEnv(name, undefined)
  }
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
})

afterAll(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A scratch repository with one commit on main and a checked-out pull request branch. */
function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'check-dco-'))
  dirs.push(dir)
  const git = (args: string[], who: Person = maintainer, input?: string) =>
    execFileSync('git', args, {
      cwd: dir,
      input,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: who.name,
        GIT_AUTHOR_EMAIL: who.email,
        GIT_COMMITTER_NAME: who.name,
        GIT_COMMITTER_EMAIL: who.email,
      },
    }).trim()
  git(['init', '--quiet', '--initial-branch=main'])
  git(['commit', '--quiet', '--allow-empty', '--message=Start'])
  git(['switch', '--quiet', '--create', 'pr'])
  return {
    dir,
    git,
    file(name: string, contents: string) {
      writeFileSync(join(dir, name), contents)
      git(['add', '--', name])
    },
    /** Creates a merge with a chosen tree, without asking git to generate its content. */
    mergeCommit(tree: string, parents: string[], who: Person, message: string) {
      const sha = git(
        ['commit-tree', tree, ...parents.flatMap((sha) => ['-p', sha]), '-F', '-'],
        who,
        message,
      )
      git(['update-ref', 'refs/heads/pr', sha])
      return sha
    },
    /** Commits on the current branch as `who`, with `message` taken verbatim. */
    commit(who: Person, message: string) {
      git(['commit', '--quiet', '--allow-empty', '--file=-'], who, message)
      return git(['rev-parse', 'HEAD'])
    },
    /** Each commit in main..pr with how it was judged. */
    check(options = { honorExemptions: true }) {
      return readCommits('main', 'pr', dir).map((commit) => ({
        commit,
        result: checkCommit(commit, options),
      }))
    },
  }
}

describe('checkCommit on commits read with readCommits', () => {
  it('passes a commit signed off by its author', () => {
    const repo = scratchRepo()
    repo.commit(jane, `Add a feature\n\nBecause.\n\n${signOff(jane)}\n`)
    const [checked] = repo.check()
    expect(checked?.commit).toMatchObject({
      subject: 'Add a feature',
      authorName: 'Jane Doe',
      authorEmail: 'jane@example.com',
      signOffs: ['Jane Doe <jane@example.com>'],
    })
    expect(checked?.result).toEqual({ status: 'signed' })
  })

  it('fails a commit by an external contributor without a sign-off', () => {
    const repo = scratchRepo()
    repo.commit(jane, 'Add a feature\n')
    expect(repo.check()[0]?.result).toEqual({
      status: 'missing',
      problem: expect.stringContaining('no Signed-off-by trailer'),
      authorExempt: false,
    })
  })

  it("exempts the maintainer, committing locally or in GitHub's web UI", () => {
    expect(EXEMPT_AUTHOR_EMAILS).toContain(maintainer.email)
    expect(EXEMPT_AUTHOR_EMAILS).toContain(maintainerOnGitHub.email)
    const repo = scratchRepo()
    repo.commit(maintainer, 'Add a feature\n')
    repo.commit(maintainerOnGitHub, 'Apply suggestions from code review\n')
    expect(repo.check().map(({ result }) => result)).toEqual([
      { status: 'exempt' },
      { status: 'exempt' },
    ])
  })

  it('exempts Dependabot, whose own sign-off names a different address', () => {
    expect(EXEMPT_AUTHOR_EMAILS).toContain(dependabot.email)
    const repo = scratchRepo()
    // The shape of a real Dependabot commit, including the "---" in the middle.
    repo.commit(
      dependabot,
      'Bump typescript from 6.0.3 to 7.0.2\n\nBumps typescript.\n\n---\nupdated-dependencies:\n' +
        '- dependency-name: typescript\n...\n\nSigned-off-by: dependabot[bot] <support@github.com>\n',
    )
    expect(repo.check()[0]?.result).toEqual({ status: 'exempt' })
    // Without the exemption it would fail: support@github.com is not the author's address.
    expect(repo.check({ honorExemptions: false })[0]?.result).toMatchObject({
      status: 'missing',
      problem: expect.stringContaining('dependabot[bot] <support@github.com>'),
    })
  })

  it('compares names and emails ignoring case', () => {
    const repo = scratchRepo()
    repo.commit({ ...jane, email: 'Jane@Example.com' }, `Fix\n\n${signOff(jane)}\n`)
    repo.commit(jane, 'Fix\n\nsigned-off-by: jane doe <JANE@example.COM>\n')
    repo.commit({ ...maintainer, email: 'Adrian@Cobaltmere.com' }, 'Fix\n')
    expect(repo.check().map(({ result }) => result.status)).toEqual(['signed', 'signed', 'exempt'])
  })

  it('fails a sign-off whose email or name differs from the author', () => {
    const repo = scratchRepo()
    repo.commit(jane, `Fix\n\n${signOff({ ...jane, email: 'jane@elsewhere.org' })}\n`)
    repo.commit(jane, `Fix\n\n${signOff({ ...jane, name: 'J. Doe' })}\n`)
    const [email, name] = repo.check()
    expect(email?.result).toEqual({
      status: 'missing',
      problem: 'Signed-off-by does not name the author: Jane Doe <jane@elsewhere.org>',
      authorExempt: false,
    })
    expect(name?.result).toMatchObject({ status: 'missing' })
  })

  it("accepts the author's sign-off among several trailers, and only the author's", () => {
    const repo = scratchRepo()
    const other: Person = { name: 'Sam Roe', email: 'sam@example.org' }
    repo.commit(
      jane,
      `Fix\n\nCo-authored-by: Sam Roe <sam@example.org>\n${signOff(other)}\n${signOff(jane)}\n`,
    )
    repo.commit(jane, `Fix\n\n${signOff(other)}\nReviewed-by: ${jane.name} <${jane.email}>\n`)
    const [both, otherOnly] = repo.check()
    expect(both?.commit.signOffs).toEqual([
      'Sam Roe <sam@example.org>',
      'Jane Doe <jane@example.com>',
    ])
    expect(both?.result).toEqual({ status: 'signed' })
    expect(otherOnly?.result).toMatchObject({ status: 'missing' })
  })

  it('follows git: a sign-off outside the last paragraph does not count', () => {
    const repo = scratchRepo()
    repo.commit(jane, `Fix\n\n${signOff(jane)}\n\nA closing paragraph.\n`)
    // A trailer block may share its paragraph with other lines when it holds a sign-off.
    repo.commit(jane, `Fix\n\nA closing line.\n${signOff(jane)}\n`)
    // A trailer value may continue on indented lines.
    repo.commit(jane, 'Fix\n\nSigned-off-by: Jane\n  Doe <jane@example.com>\n')
    const [middle, mixed, folded] = repo.check()
    expect(middle?.commit.signOffs).toEqual([])
    expect(middle?.result).toMatchObject({ status: 'missing' })
    expect(mixed?.result).toEqual({ status: 'signed' })
    expect(folded?.commit.signOffs).toEqual(['Jane Doe <jane@example.com>'])
    expect(folded?.result).toEqual({ status: 'signed' })
  })

  it('reads a sign-off after a "---" line, which is not a divider in a commit message', () => {
    const repo = scratchRepo()
    repo.commit(jane, `Fix\n\nNotes\n---\nmore notes\n\n${signOff(jane)}\n`)
    expect(repo.check()[0]?.result).toEqual({ status: 'signed' })
  })

  it('skips clean merges but checks every commit they bring in', () => {
    const repo = scratchRepo()
    repo.file('feature.txt', 'Feature\n')
    repo.commit(jane, `Add a feature\n\n${signOff(jane)}\n`)
    // main moves on; the contributor merges it in, as CONTRIBUTING.md asks.
    repo.git(['switch', '--quiet', 'main'])
    repo.file('main.txt', 'Main\n')
    repo.commit(maintainer, 'Change main\n')
    repo.git(['switch', '--quiet', 'pr'])
    repo.git(['merge', '--quiet', '--no-edit', 'main'], jane)
    // A side branch with an unsigned commit, merged into the pull request branch.
    repo.git(['switch', '--quiet', '--create', 'side', 'main'])
    repo.commit(jane, 'Side work\n')
    repo.git(['switch', '--quiet', 'pr'])
    repo.git(['merge', '--quiet', '--no-ff', '--no-edit', 'side'], jane)

    const statuses = repo.check().map(({ commit, result }) => [commit.subject, result.status])
    expect(Object.fromEntries(statuses)).toEqual({
      'Add a feature': 'signed',
      "Merge branch 'main' into pr": 'merge',
      'Side work': 'missing',
      "Merge branch 'side' into pr": 'merge',
    })
  })

  it.each([false, true])('requires the author sign-off for an evil merge (signed=%s)', (signed) => {
    const repo = scratchRepo()
    const first = repo.commit(maintainer, 'Move main forward\n')
    const second = repo.git(['rev-parse', 'main'])
    repo.file('evil.txt', 'Content in neither parent\n')
    const tree = repo.git(['write-tree'])
    const sha = repo.mergeCommit(
      tree,
      [first, second],
      jane,
      `Merge main\n${signed ? `\n${signOff(jane)}\n` : ''}`,
    )
    const merge = repo.check().find(({ commit }) => commit.sha === sha)
    expect(merge?.commit.cleanMerge).toBe(false)
    expect(merge?.result).toMatchObject({ status: signed ? 'signed' : 'missing' })
    const cli = spawnSync(process.execPath, [script, '--no-exemptions', first, sha], {
      cwd: repo.dir,
      encoding: 'utf8',
    })
    expect(cli.status).toBe(signed ? 0 : 1)
  })

  it('applies ordinary same-repository exemptions to evil merges, but never to forks', () => {
    const repo = scratchRepo()
    const first = repo.commit(maintainer, 'Move main forward\n')
    repo.file('extra.txt', 'Extra content\n')
    const sha = repo.mergeCommit(
      repo.git(['write-tree']),
      [first, repo.git(['rev-parse', 'main'])],
      maintainer,
      'Merge main\n',
    )
    expect(repo.check().find(({ commit }) => commit.sha === sha)?.result).toEqual({
      status: 'exempt',
    })
    expect(
      repo.check({ honorExemptions: false }).find(({ commit }) => commit.sha === sha)?.result,
    ).toMatchObject({ status: 'missing', authorExempt: true })
  })

  it('requires a sign-off for a merge that resolves conflicts', () => {
    const repo = scratchRepo()
    repo.file('shared.txt', 'Feature content\n')
    repo.commit(jane, `Feature\n\n${signOff(jane)}\n`)
    repo.git(['switch', '--quiet', 'main'])
    repo.file('shared.txt', 'Main content\n')
    repo.commit(maintainer, 'Change main\n')
    repo.git(['switch', '--quiet', 'pr'])
    expect(() => repo.git(['merge', '--quiet', '--no-edit', 'main'], jane)).toThrow()
    repo.file('shared.txt', 'Resolved content\n')
    const sha = repo.commit(jane, 'Resolve the conflict\n')
    const merge = repo.check().find(({ commit }) => commit.sha === sha)
    expect(merge?.commit).toMatchObject({ cleanMerge: false, parents: expect.any(Array) })
    expect(merge?.commit.parents).toHaveLength(2)
    expect(merge?.result).toMatchObject({ status: 'missing' })
    repo.git(
      ['commit', '--quiet', '--amend', '-F', '-'],
      jane,
      `Resolve the conflict\n\n${signOff(jane)}\n`,
    )
    expect(repo.check().at(-1)?.result).toEqual({ status: 'signed' })
  })

  it('requires a sign-off even when a conflicted merge commits the automatic conflict-marker tree', () => {
    const repo = scratchRepo()
    repo.file('shared.txt', 'Feature content\n')
    const feature = repo.commit(jane, `Feature\n\n${signOff(jane)}\n`)
    repo.git(['switch', '--quiet', 'main'])
    repo.file('shared.txt', 'Main content\n')
    const main = repo.commit(maintainer, 'Change main\n')
    const automatic = spawnSync('git', ['merge-tree', '--write-tree', feature, main], {
      cwd: repo.dir,
      encoding: 'utf8',
    })
    expect(automatic.status).toBe(1)
    const tree = automatic.stdout.split('\n')[0] ?? ''
    const sha = repo.mergeCommit(tree, [feature, main], jane, 'Merge with conflict markers\n')
    const merge = repo.check().find(({ commit }) => commit.sha === sha)
    expect(merge?.commit.cleanMerge).toBe(false)
    expect(merge?.result).toMatchObject({ status: 'missing' })
  })

  it('requires a sign-off for octopus merges', () => {
    const repo = scratchRepo()
    const main = repo.git(['rev-parse', 'main'])
    const first = repo.commit(maintainer, 'First parent\n')
    const second = repo.commit(maintainer, 'Second parent\n')
    const sha = repo.mergeCommit(repo.git(['write-tree']), [main, first, second], jane, 'Octopus\n')
    const merge = repo.check().find(({ commit }) => commit.sha === sha)
    expect(merge?.commit.parents).toHaveLength(3)
    expect(merge?.result).toMatchObject({ status: 'missing' })
  })

  it.each([false, true])(
    'checks an unrelated-histories merge with ordinary sign-off rules (signed=%s)',
    (signed) => {
      const repo = scratchRepo()
      const main = repo.git(['rev-parse', 'main'])
      repo.git(['switch', '--quiet', '--orphan', 'unrelated'])
      repo.file('unrelated.txt', 'Separate history\n')
      const unrelated = repo.commit(jane, `Unrelated root\n\n${signOff(jane)}\n`)
      const tree = repo.git(['write-tree'])
      repo.git(['switch', '--quiet', 'pr'])
      const sha = repo.mergeCommit(
        tree,
        [main, unrelated],
        jane,
        `Join unrelated histories\n${signed ? `\n${signOff(jane)}\n` : ''}`,
      )
      const cli = spawnSync(process.execPath, [script, '--no-exemptions', 'main', 'pr'], {
        cwd: repo.dir,
        encoding: 'utf8',
      })
      expect(cli.status).toBe(signed ? 0 : 1)
      const merge = repo.check().find(({ commit }) => commit.sha === sha)
      expect(merge?.commit.cleanMerge).toBe(false)
      expect(merge?.result).toMatchObject({ status: signed ? 'signed' : 'missing' })
    },
  )

  it('without exemptions (pull requests from forks), the maintainer needs a sign-off too', () => {
    const repo = scratchRepo()
    repo.commit(maintainer, 'Add a feature\n')
    repo.commit(maintainer, `Add another\n\n${signOff(maintainer)}\n`)
    const [unsigned, signed] = repo.check({ honorExemptions: false })
    expect(unsigned?.result).toMatchObject({ status: 'missing', authorExempt: true })
    expect(signed?.result).toEqual({ status: 'signed' })
  })

  it('reads commits oldest first and rejects a revision that is not a commit', () => {
    const repo = scratchRepo()
    const first = repo.commit(jane, 'First\n')
    const second = repo.commit(jane, 'Second\n')
    expect(readCommits('main', 'pr', repo.dir).map(({ sha }) => sha)).toEqual([first, second])
    expect(() => readCommits('main', 'no-such-branch', repo.dir)).toThrow(
      'no-such-branch is not a commit',
    )
    expect(() => readCommits('--output=x', 'pr', repo.dir)).toThrow('is not a commit')
  })
})

describe('formatReport', () => {
  const LS = String.fromCodePoint(0x2028) // line separator
  const RLO = String.fromCodePoint(0x202e) // right-to-left override
  const commit = (fields: Partial<Commit>): Commit => ({
    sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    parents: ['0'.repeat(40)],
    cleanMerge: false,
    authorName: jane.name,
    authorEmail: jane.email,
    subject: 'Fix the thing',
    signOffs: [],
    ...fields,
  })

  it('lists failing commits by short SHA and subject, with the fix', () => {
    const report = formatReport('main..pr', [
      { commit: commit({ subject: 'Fix the thing' }), result: checkCommit(commit({}), opts) },
      {
        commit: commit({ sha: `ffff000${'0'.repeat(33)}`, subject: 'Signed one' }),
        result: { status: 'signed' },
      },
    ])
    expect(report).toContain('  MISSING  a1b2c3d  Fix the thing')
    expect(report).toContain('  ok       ffff000  Signed one')
    expect(report).toContain('1 commit(s) need a sign-off:')
    expect(report).toContain('    expected: Signed-off-by: Jane Doe <jane@example.com>')
    expect(report).toContain('git commit --amend --signoff --no-edit')
    expect(report).toContain('git rebase --signoff <base>')
    expect(report).toContain('CONTRIBUTING.md#license-and-sign-off')
    expect(report).not.toContain('forks')
  })

  it('explains that exemptions are off in a pull request from a fork', () => {
    const fromFork = commit({ authorEmail: maintainer.email })
    const report = formatReport('main..pr', [
      { commit: fromFork, result: checkCommit(fromFork, { honorExemptions: false }) },
    ])
    expect(report).toContain('Exemptions are off for pull requests from forks')
  })

  it('escapes control characters so commit text cannot start a line', () => {
    const hostile = commit({
      subject: `Fix\n::error::pwned\r::add-mask::x${LS}::warning::y \u001b[31mred${RLO}`,
      authorName: 'Eve\n::stop-commands::t',
      signOffs: ['Eve\n::error::z <eve@example.com>'],
    })
    const report = formatReport('main..pr', [
      { commit: hostile, result: checkCommit(hostile, opts) },
    ])
    for (const line of report.split('\n')) expect(line.trimStart()).not.toMatch(/^::/)
    expect(report).toContain('Fix\\u{a}::error::pwned\\u{d}::add-mask::x\\u{2028}')
    expect(report).toContain('\\u{1b}[31mred\\u{202e}')
    expect(displayText('plain text, ünïcödé and emoji 🙂')).toBe('plain text, ünïcödé and emoji 🙂')
  })

  it('escapes legacy workflow commands anywhere in untrusted text', () => {
    // The runner finds the legacy ##[command] syntax anywhere in a line, even after
    // our own prefix (actions/runner, Runner.Common/ActionCommand.cs, TryParse).
    const hostile = commit({
      subject: 'Fix ##[error]forged annotation',
      authorName: 'Eve ##[add-mask]MISSING',
      signOffs: ['Other ##[stop-commands]token <other@example.com>'],
    })
    const report = formatReport('base##[warning]..head', [
      { commit: hostile, result: checkCommit(hostile, opts) },
    ])
    expect(report).not.toContain('##[')
    expect(report).toContain('Fix \\u{23}#[error]forged annotation')
    expect(report).toContain('Eve \\u{23}#[add-mask]MISSING')
    expect(report).toContain('Other \\u{23}#[stop-commands]token')
    expect(report).toContain('base\\u{23}#[warning]..head')
  })
})

describe('the command line', () => {
  const run = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })

  it('exits 0 when every commit passes and 1 when any needs a sign-off', () => {
    const repo = scratchRepo()
    repo.commit(jane, `Fix\n\n${signOff(jane)}\n`)
    repo.commit(maintainer, 'Tidy up\n')
    const passed = run(repo.dir, 'main', 'pr')
    expect(passed.status).toBe(0)
    expect(passed.stdout).toContain('Every commit is signed off, exempt or a clean merge.')

    const failed = run(repo.dir, '--no-exemptions', 'main', 'pr')
    expect(failed.status).toBe(1)
    expect(failed.stdout).toMatch(/MISSING {2}[0-9a-f]{7} {2}Tidy up/)
  })

  it('treats names and messages as text, never as shell', () => {
    const repo = scratchRepo()
    const marker = join(repo.dir, 'pwned')
    repo.commit(
      { name: `$(touch ${marker})`, email: 'eve@example.com' },
      `\`touch ${marker}\`; touch ${marker}\n`,
    )
    const result = run(repo.dir, 'main', 'pr')
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`\`touch ${marker}\`; touch ${marker}`)
    expect(result.stdout).toContain(`author:   $(touch ${marker}) <eve@example.com>`)
    expect(existsSync(marker)).toBe(false)
  })

  it('exits 2 on bad arguments or an unknown revision', () => {
    const repo = scratchRepo()
    expect(run(repo.dir, 'main').status).toBe(2)
    expect(run(repo.dir, '--unknown', 'main', 'pr').status).toBe(2)
    const unknown = run(repo.dir, 'main', 'nope')
    expect(unknown.status).toBe(2)
    expect(unknown.stderr).toContain('nope is not a commit')
  })

  it('escapes legacy workflow commands in CLI error output', () => {
    const repo = scratchRepo()
    const failed = run(repo.dir, 'main', '##[error]forged')
    expect(failed.status).toBe(2)
    expect(failed.stderr).not.toContain('##[')
    expect(failed.stderr).toContain('\\u{23}#[error]forged is not a commit')
  })
})

describe('the DCO workflow fork boundary', () => {
  const workflow = () =>
    readFileSync(new URL('../.github/workflows/dco.yml', import.meta.url), 'utf8')

  it('detects forks by comparing the head repository with the current repository', () => {
    const expression = /^\s+FROM_FORK: \$\{\{ (.+) \}\}$/m.exec(workflow())?.[1]
    expect(expression).toBe('github.event.pull_request.head.repo.full_name != github.repository')
  })

  it.each(['false', 'true', '', 'False', 'FALSE', ' false', 'false ', '0', 'unknown'])(
    'enables exemptions only for the literal false (FROM_FORK=%j)',
    (fromFork) => {
      const repo = scratchRepo()
      repo.commit(maintainer, 'Unsigned maintainer commit\n')
      mkdirSync(join(repo.dir, 'scripts'))
      copyFileSync(script, join(repo.dir, 'scripts/check-dco.ts'))
      const block = /\n {8}run: \|\n((?: {10}.*(?:\n|$))*)/.exec(workflow())?.[1]
      expect(block).toBeDefined()
      const result = spawnSync('bash', ['-e', '-c', block ?? 'exit 99'], {
        cwd: repo.dir,
        encoding: 'utf8',
        env: { ...process.env, FROM_FORK: fromFork, BASE_SHA: 'main', HEAD_SHA: 'pr' },
      })
      expect(result.status).toBe(fromFork === 'false' ? 0 : 1)
      expect(result.stdout).toContain(fromFork === 'false' ? 'exempt' : 'MISSING')
    },
  )
})
