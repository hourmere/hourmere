#!/usr/bin/env node
import { runCli } from './cli.ts'

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  stdin: process.stdin,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
})
