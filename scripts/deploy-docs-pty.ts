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
  // newlines after each prompt to avoid overflowing the terminal input queue,
  // without bracketed-paste framing and with zsh's options at defaults.
  const result = spawnSync(
    'python3',
    [
      '-c',
      `import errno, os, pty, re, sys
lines = iter(sys.stdin.buffer.read().splitlines(keepends=True))
pid, master = pty.fork()
if pid == 0:
    os.execv("/bin/sh", ["/bin/sh", "-i"])
pending = b""
try:
    while True:
        try:
            data = os.read(master, 4096)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not data:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
        pending += data
        while (prompt := re.search(rb"HOURMERE_(?:PRIMARY|CONTINUE)> ", pending)):
            pending = pending[prompt.end():]
            line = next(lines, None)
            if line is not None:
                os.write(master, line)
finally:
    os.close(master)
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))`,
    ],
    {
      cwd,
      env: {
        ...env,
        TERM: 'dumb',
        ZDOTDIR: cwd,
        PS1: 'HOURMERE_PRIMARY> ',
        PS2: 'HOURMERE_CONTINUE> ',
      },
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
