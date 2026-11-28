import type { Plugin } from 'vite'

/** Use hashed module URLs so a failed native import can be retried with a fresh URL. */
export function catalogueChunks(): Plugin {
  return {
    name: 'hourmere-catalogue-chunks',
    apply: 'build',
    applyToEnvironment: (environment) => environment.config.consumer === 'client',
    enforce: 'pre',
    load(id) {
      const group = id.match(/\/catalogues\/[^/]+\/(common|admin)\.ts\?url$/)?.[1]
      if (!group) return
      const reference = this.emitFile({
        type: 'chunk',
        id: id.slice(0, -'?url'.length),
        preserveSignature: 'strict',
      })
      // The source glob identifies all modules in the runtime graph. Each generated
      // loader closes over its own emitted asset, so only the retry query can vary.
      return `
        export default async function loadCatalogue(attempt) {
          const target = new URL(import.meta.ROLLUP_FILE_URL_${reference}, import.meta.url)
          // A browser caches failed module imports using their original URL.
          if (attempt) target.searchParams.set('retry', String(attempt))
          const { ${group}: catalogue } = await import(/* @vite-ignore */ target.href)
          if (!catalogue || typeof catalogue !== 'object') throw new Error('Invalid interface catalogue')
          return catalogue
        }
      `
    },
  }
}
