import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

// Static site for hourmere.com. The homepage and legal pages are plain Astro pages in
// src/pages; Starlight serves documentation from src/content/docs.
export default defineConfig({
  site: 'https://hourmere.com',
  // Emit privacy.html rather than privacy/index.html, so /privacy is served without a
  // redirect (Google requires a static, non-redirecting privacy policy URL). Unlike 'file',
  // 'preserve' keeps Starlight's links free of ".html".
  build: { format: 'preserve' },
  trailingSlash: 'never',
  // Astro's HTML compression drops the space at a line break next to an inline element
  // ("the\n<a>" renders as "the<a>"), which glues words together in the legal pages.
  compressHTML: false,
  integrations: [
    starlight({
      title: 'Hourmere',
      description: 'Open-source scheduling for people and AI agents.',
      logo: {
        light: './src/assets/brand/hourmere-mark.svg',
        dark: './src/assets/brand/hourmere-mark-white.svg',
        alt: '',
      },
      favicon: '/favicon.svg',
      head: [
        {
          tag: 'link',
          attrs: { rel: 'icon', href: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
        },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
      ],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/cobaltmere' }],
      sidebar: [{ label: 'Overview', link: '/docs' }],
      customCss: ['@fontsource-variable/manrope', './src/styles/starlight.css'],
      components: { Footer: './src/components/DocsFooter.astro' },
      routeMiddleware: './src/route-data.ts',
      // The site has its own 404 page in src/pages.
      disable404Route: true,
      credits: false,
    }),
  ],
})
