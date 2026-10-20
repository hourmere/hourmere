import { readFileSync } from 'node:fs'

// One published source for the website and application. The Docker image copies this
// exact file too, so the server does not depend on an Astro build or WEB_DIST.
export const securityTxt = readFileSync(
  new URL('../../site/public/.well-known/security.txt', import.meta.url),
  'utf8',
)
