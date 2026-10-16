// Starts the API (with reload) and the Vite dev server together; Ctrl+C stops both.
import { spawn } from 'node:child_process'

// In development people use the app through Vite, which proxies /api to the server, so
// sign-in links and cookies must point at Vite's origin rather than the server's port. This
// takes precedence over PUBLIC_URL in .env, which describes the self-hosted (docker) setup.
const server = { ...process.env, PUBLIC_URL: 'http://localhost:5173' }

const procs = [
  spawn('npm', ['run', 'dev', '--workspace', '@hourmere/server'], {
    stdio: 'inherit',
    env: server,
  }),
  spawn('npm', ['run', 'dev', '--workspace', '@hourmere/web'], { stdio: 'inherit' }),
]

function stop(code = 0) {
  for (const p of procs) p.kill('SIGTERM')
  process.exit(code)
}
for (const p of procs) p.on('exit', (code) => stop(code ?? 0))
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
