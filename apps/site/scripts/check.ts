// Runs `astro check` with TypeScript 6.
//
// astro check is built on TypeScript's JavaScript API, which TypeScript 7 (used by the rest of
// the repo) does not ship. npm hoists the checker (@volar/kit) to the repo root, where its
// require('typescript') would load 7.x, so every `typescript` import in this process is
// resolved to the 6.x copy installed for this app before the Astro CLI starts.
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const typescript = pathToFileURL(require.resolve('typescript')).href

registerHooks({
  resolve: (specifier, context, nextResolve) =>
    specifier === 'typescript'
      ? { url: typescript, shortCircuit: true }
      : nextResolve(specifier, context),
})

const astro = join(dirname(require.resolve('astro/package.json')), 'bin/astro.mjs')
process.argv = [process.execPath, astro, 'check', ...process.argv.slice(2)]
await import(pathToFileURL(astro).href)
