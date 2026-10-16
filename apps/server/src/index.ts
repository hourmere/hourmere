import { startServer } from './server.ts'

const server = await startServer()

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`)
  server.close().then(
    () => process.exit(0),
    (err) => {
      console.error('shutdown failed:', err)
      process.exit(1)
    },
  )
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
