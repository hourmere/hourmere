import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

// The n8n lint packages bundle their own TypeScript copies. Resolve every `typescript`
// import to this package's pinned compiler; keep the official n8n rules unchanged.
const require = createRequire(import.meta.url)
const compilerUrl = pathToFileURL(require.resolve('typescript')).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === 'typescript'
      ? { url: compilerUrl, shortCircuit: true }
      : nextResolve(specifier, context)
  },
})
const { configWithoutCloudSupport } = await import('@n8n/node-cli/eslint')

// Node's crypto implements Hourmere's signed delivery protocol. This local community
// package does not claim n8n Cloud verification, whose rules prohibit built-in imports.
export default [
  ...configWithoutCloudSupport,
  { ignores: ['**/*.test.ts', 'scripts/**'] },
  {
    files: ['package.json'],
    rules: {
      // This repository's code is AGPL-3.0-only; publishing cannot relicense it to MIT.
      'n8n-nodes-base/community-package-json-license-not-default': 'off',
    },
  },
]
