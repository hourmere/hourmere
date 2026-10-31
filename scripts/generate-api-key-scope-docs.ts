import { readFileSync, writeFileSync } from 'node:fs'
import { replaceScopeTables, SCOPE_DOC_FILES } from './api-key-scope-docs.ts'

// Run from the repository root after changing the operation registry.
for (const { path, section } of SCOPE_DOC_FILES) {
  const source = readFileSync(path, 'utf8')
  const generated = replaceScopeTables(source, section)
  if (generated !== source) writeFileSync(path, generated)
}
