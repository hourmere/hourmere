// Starts the API (with reload) and the Vite dev server together; Ctrl+C stops both.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

// Anyone may sign up in development, so trying several accounts needs no setup. SIGNUP or
// SIGNUP_ALLOWED_DOMAINS from the environment or .env still decide when set; a self-hosted
// instance defaults to first-user.
const dotenv = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {}
const isSet = (name: string) => Boolean(process.env[name] || dotenv[name])
const signup = isSet('SIGNUP') || isSet('SIGNUP_ALLOWED_DOMAINS') ? {} : { SIGNUP: 'open' }

// In development people use the app through Vite, which proxies /api to the server, so
// sign-in links and cookies must point at Vite's origin rather than the server's port. This
// takes precedence over PUBLIC_URL in .env, which describes the self-hosted (docker) setup.
const server = { ...process.env, ...signup, PUBLIC_URL: 'http://localhost:5173' }

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
