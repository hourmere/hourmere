import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listenOwned } from './listeners.ts'

const directory = fileURLToPath(new URL('../../apps/site/dist/', import.meta.url))
const contentTypes: Record<string, string> = {
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

// No database, app server, environment-file fallback or production service is used.
export async function startSiteFixture() {
  await readFile(resolve(directory, 'docs/configuration.html'))
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://local').pathname)
      const path = resolve(directory, `.${pathname}`)
      if (path !== resolve(directory) && !path.startsWith(directory)) {
        response.writeHead(404).end()
        return
      }
      const candidates = extname(path) ? [path] : [`${path}.html`, resolve(path, 'index.html')]
      for (const candidate of candidates) {
        try {
          const body = await readFile(candidate)
          response.writeHead(200, {
            'Content-Type': contentTypes[extname(candidate)] ?? 'application/octet-stream',
          })
          response.end(request.method === 'HEAD' ? undefined : body)
          return
        } catch {
          // Astro's preserve output uses .html; retain index.html for directory routes.
        }
      }
      response.writeHead(404).end()
    } catch {
      response.writeHead(400).end()
    }
  })
  const owned = await listenOwned(server)
  return { origin: owned.url, close: () => owned.close() }
}
