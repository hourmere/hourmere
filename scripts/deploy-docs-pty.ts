import { spawnSync } from 'node:child_process'

export function deploymentPasteSkipReason(env: NodeJS.ProcessEnv): string | undefined {
  const missing = ['zsh', 'python3'].filter(
    (tool) => spawnSync(tool, ['--version'], { env, timeout: 4000 }).status !== 0,
  )
  if (!missing.length) return undefined
  const reason = `Missing ${missing.join(' and ')} on PATH for the deployment paste tests`
  if (env.CI)
    throw new Error(`CI must install zsh and python3 for the deployment paste tests. ${reason}`)
  return reason
}

export function pasteIntoZshPty(input: string, cwd: string, env: NodeJS.ProcessEnv) {
  // Standard-library pty keeps stdin a terminal on macOS and Linux. Send literal
  // newlines without bracketed-paste framing, leaving zsh's options at defaults.
  const result = spawnSync(
    'python3',
    [
      '-c',
      'import os, pty, sys\nsys.exit(os.waitstatus_to_exitcode(pty.spawn(["/bin/sh", "-i"])))',
    ],
    {
      cwd,
      env: { ...env, TERM: 'dumb', ZDOTDIR: cwd },
      input,
      encoding: 'utf8',
      timeout: 4000,
    },
  )
  return {
    status: result.status,
    stdout: result.stdout?.replaceAll('\r', '') ?? '',
    stderr: [result.stderr, result.error?.message].filter(Boolean).join('\n'),
  }
}
