import { readFileSync, writeFileSync } from 'node:fs'
import { darkTokens, tokens } from '../src/index.ts'

function declarations(values: Record<string, string>, indent: string): string {
  return Object.entries(values)
    .map(([name, value]) => `${indent}${name}: ${value};`)
    .join('\n')
}

const css = `/* Generated from src/index.ts by npm run generate --workspace @hourmere/design-tokens. */

:root {
${declarations(tokens, '  ')}
}

@media (prefers-color-scheme: dark) {
  :root {
${declarations(darkTokens, '    ')}
  }
}
`

const stylesheet = new URL('../tokens.css', import.meta.url)
if (process.argv.includes('--check')) {
  if (readFileSync(stylesheet, 'utf8') !== css) {
    console.error(
      'Design token CSS is out of date. Run npm run generate --workspace @hourmere/design-tokens.',
    )
    process.exitCode = 1
  }
} else {
  writeFileSync(stylesheet, css)
}
