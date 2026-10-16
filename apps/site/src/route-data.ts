import { defineRouteMiddleware } from '@astrojs/starlight/route-data'

// Docs pages are written as files like docs.html but served without the extension (see
// build.format in astro.config.ts). Starlight builds the canonical and og:url links from the
// output path, so drop the ".html" to match the sitemap and the links between pages.
export const onRequest = defineRouteMiddleware((context) => {
  for (const { tag, attrs } of context.locals.starlightRoute.head) {
    if (!attrs) continue
    if (tag === 'link' && attrs.rel === 'canonical' && typeof attrs.href === 'string') {
      attrs.href = attrs.href.replace(/\.html$/, '')
    }
    if (tag === 'meta' && attrs.property === 'og:url' && typeof attrs.content === 'string') {
      attrs.content = attrs.content.replace(/\.html$/, '')
    }
  }
})
