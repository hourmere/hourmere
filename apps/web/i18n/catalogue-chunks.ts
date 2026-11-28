import type { Plugin } from 'vite'

/** Use hashed module URLs so a failed native import can be retried with a fresh URL. */
export function catalogueChunks(): Plugin {
  return {
    name: 'hourmere-catalogue-chunks',
    apply: 'build',
    applyToEnvironment: (environment) => environment.config.consumer === 'client',
    enforce: 'pre',
    load(id) {
      if (!/\/catalogues\/[^/]+\/(common|admin)\.ts\?url$/.test(id)) return
      const reference = this.emitFile({
        type: 'chunk',
        id: id.slice(0, -'?url'.length),
        preserveSignature: 'strict',
      })
      return `export default import.meta.ROLLUP_FILE_URL_${reference}`
    },
  }
}
