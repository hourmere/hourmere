import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

export function isShellAsset(path: string): boolean {
  return (
    path === '/index.html' ||
    path === '/app/offline.html' ||
    path === '/app/offline.css' ||
    /^\/assets\/[^/]+-[\w-]+\.(js|css|woff2?)$/.test(path) ||
    /^\/app\/(icon-192|icon-512|maskable-192|maskable-512|apple-touch-icon)\.png$/.test(path)
  )
}

/** No runtime manifest or dependencies: the output files themselves define each cache version. */
export function offlineShell(): Plugin {
  let output: string
  let writeOutput = true
  return {
    name: 'hourmere-offline-shell',
    apply: 'build',
    configResolved(config) {
      writeOutput = config.build.write
      output = resolve(config.root, config.build.outDir)
    },
    async closeBundle() {
      // Analysis builds return their bundle in memory and must not inspect or create dist.
      if (!writeOutput) return
      await mkdir(resolve(output, 'app'), { recursive: true })
      const offline = await readFile(new URL('./offline.html', import.meta.url), 'utf8')
      await writeFile(resolve(output, 'app/offline.html'), offline)
      await writeFile(
        resolve(output, 'app/offline.css'),
        await readFile(new URL('./offline.css', import.meta.url)),
      )
      const files = await readdir(output, { recursive: true })
      const precache = files
        .map((file) => `/${file}`)
        .filter(isShellAsset)
        .sort()
      if (!precache.includes('/index.html') || !precache.includes('/app/offline.html')) {
        throw new Error('Missing offline shell entry')
      }
      // Fail closed if a later edit broadens selection to data routes or arbitrary files.
      if (
        precache.some(
          (path) => !isShellAsset(path) || /\/(api|mcp|oauth2|embed|manage)\//.test(path),
        )
      ) {
        throw new Error('Unsafe precache entry')
      }
      const hash = createHash('sha256')
      const worker = await readFile(new URL('./worker.js', import.meta.url), 'utf8')
      hash.update(worker)
      for (const path of precache) {
        hash.update(path)
        hash.update(await readFile(resolve(output, path.slice(1))))
      }
      const source = worker
        .replace('__PRECACHE__', JSON.stringify(precache))
        .replace(
          '__CACHE_NAME__',
          JSON.stringify(`hourmere-shell-${hash.digest('hex').slice(0, 20)}`),
        )
      await writeFile(resolve(output, 'app/sw.js'), source)
    },
  }
}
