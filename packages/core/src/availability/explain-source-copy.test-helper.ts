import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { expect } from 'vitest'
import type { explainAvailability } from './explain-availability.ts'
import { intervalIndex } from './interval-index.ts'
import { AVAILABILITY_REASON_CODES } from './types.ts'
import { AvailabilityInputError, normalizeInput, resolveDurationMinutes } from './validate.ts'

type Explain = typeof explainAvailability
type Change = readonly [string, string]

export function explainSourceCopy(change?: Change): Explain {
  let source = readFileSync(new URL('./explain-availability.ts', import.meta.url), 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'mutation must match source').toBe(true)
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source)
    .replace(/^import[\s\S]*?from '[^']+'\n/gm, '')
    .replace(/\bexport /g, '')
  const bindings = {
    intervalIndex,
    AVAILABILITY_REASON_CODES,
    AvailabilityInputError,
    normalizeInput,
    resolveDurationMinutes,
  }
  return new Function(...Object.keys(bindings), `${source}; return explainAvailability`)(
    ...Object.values(bindings),
  )
}
