const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

function verifyTree(directory, lock) {
  const actual = []
  function visitModules(relative) {
    const absolute = join(directory, relative)
    if (!existsSync(absolute)) return
    for (const name of readdirSync(absolute)) {
      if (name.startsWith('.')) continue
      if (name.startsWith('@')) {
        for (const child of readdirSync(join(absolute, name)))
          visitPackage(`${relative}/${name}/${child}`)
      } else visitPackage(`${relative}/${name}`)
    }
  }
  function visitPackage(relative) {
    actual.push(relative)
    visitModules(`${relative}/node_modules`)
  }
  visitModules('node_modules')
  const expected = Object.entries(lock.packages)
    .filter(
      ([path, pkg]) =>
        path && !pkg.dev && (!(pkg.optional || pkg.devOptional) || actual.includes(path)),
    )
    .map(([path]) => path)
  assert.deepEqual(
    actual.sort(),
    expected.sort(),
    'Built production dependency set differs from lock',
  )
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (!actual.includes(path)) continue
    const installed = JSON.parse(readFileSync(join(directory, path, 'package.json'), 'utf8'))
    assert.equal(
      installed.version.replace(/^v/, ''),
      pkg.version.replace(/^v/, ''),
      `Built dependency differs from lock: ${path}`,
    )
  }
}

async function main() {
  // Read the committed input before the CLI copies it and runs its production install.
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  const { buildAndOrUpload } = require(require.resolve('zapier-platform-cli/src/utils/build'))
  const decompress = require('zapier-platform-cli/src/utils/decompress')
  // Build only. No registration, authentication, upload or platform network validation.
  process.env.HOURMERE_ZAPIER_PUSH_APPROVED = '1'
  await buildAndOrUpload(
    { build: true },
    { disableDependencyDetection: true, checkOutdated: false, skipValidation: true },
  )
  const directory = mkdtempSync(join(tmpdir(), 'hourmere-zapier-built-'))
  try {
    await decompress('build/build.zip', directory)
    verifyTree(directory, lock)
    console.log('All built production dependency versions match package-lock.json.')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

module.exports = { verifyTree }
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
