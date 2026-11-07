#!/usr/bin/env node
import { runCli } from './cli.ts'

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  stdin: process.stdin,
  stdout: (text) =>
    new Promise<void>((resolve, reject) => {
      process.stdout.write(text, (error) => (error ? reject(error) : resolve()))
    }),
  stderr: (text) => process.stderr.write(text),
})
