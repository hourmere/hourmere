import { fileURLToPath } from 'node:url'
import { interfaceLanguages } from '@hourmere/core/language'
import { defineConfig } from 'vite'

// A standalone classic script for third-party sites; no React or application state.
export default defineConfig({
  publicDir: false,
  plugins: [
    {
      name: 'hourmere-widget-catalogues',
      async generateBundle() {
        for (const locale of interfaceLanguages('public')) {
          if (locale === 'en') continue
          const catalogue = new URL(`./src/i18n/catalogues/${locale}/widget.ts`, import.meta.url)
          const { widget } = await import(catalogue.href)
          this.emitFile({
            type: 'asset',
            fileName: `hourmere-embed-locale-${locale}.js`,
            source: `document.currentScript.hourmereMessages(${JSON.stringify(widget)});`,
          })
        }
      },
    },
  ],
  build: {
    outDir: 'public',
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL('./src/embed/entry.ts', import.meta.url)),
      name: 'HourmereEmbed',
      formats: ['iife'],
      fileName: () => 'hourmere-embed.js',
    },
  },
})
