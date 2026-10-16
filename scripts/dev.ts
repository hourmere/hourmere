// Starts the API (with reload) and the Vite dev server together; Ctrl+C stops both.
import { spawn } from 'node:child_process'

const procs = [
  spawn('npm', ['run', 'dev', '--workspace', '@hourmere/server'], { stdio: 'inherit' }),
  spawn('npm', ['run', 'dev', '--workspace', '@hourmere/web'], { stdio: 'inherit' }),
]

function stop(code = 0) {
  for (const p of procs) p.kill('SIGTERM')
  process.exit(code)
}
for (const p of procs) p.on('exit', (code) => stop(code ?? 0))
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
