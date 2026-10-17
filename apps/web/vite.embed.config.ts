import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// A standalone classic script for third-party sites; no React or application state.
export default defineConfig({
  publicDir: false,
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
