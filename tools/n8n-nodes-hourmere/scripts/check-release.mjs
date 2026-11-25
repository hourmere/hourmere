import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
assert.match(version, /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$/, 'Require a stable npm version')
const ref = `refs/tags/n8n-v${version}`
assert.equal(process.env.GITHUB_REF, ref, `Dispatch the workflow on ${ref}`)

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
assert(
  changelog.split(/\r?\n(?=## )/).some((section) => {
    const [heading, ...body] = section.split(/\r?\n/)
    return heading === `## ${version}` && body.some((line) => line.trim())
  }),
  `Add a ## ${version} entry to CHANGELOG.md`,
)

const cwd = new URL('..', import.meta.url)
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
assert.equal(
  git('rev-parse', '--verify', `${ref}^{commit}`),
  git('rev-parse', 'HEAD'),
  `The ${ref} tag must point to the checked-out commit`,
)
assert.equal(
  git('merge-base', 'HEAD', 'refs/remotes/origin/main'),
  git('rev-parse', 'HEAD'),
  `The ${ref} tag must point to a commit on origin/main`,
)
