import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import * as scheduling from '@hourmere/scheduling'
import { describe, expect, it } from 'vitest'

async function sourceCopy(reexportHelper = false) {
  const location = new URL('./index.ts', import.meta.url)
  let source = readFileSync(location, 'utf8')
  if (reexportHelper) source += "\nexport { cancelTeamBookingInTransaction } from './bookings.ts'\n"
  source = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

function verifyBoundary(module: Record<string, unknown>) {
  expect(module).not.toHaveProperty('cancelTeamBookingInTransaction')
  expect(module).toHaveProperty('cancelTeamAdminBooking', expect.any(Function))
}

describe('scheduling exports', () => {
  it('keeps the team booking transaction helper internal to the cancellation service', async () => {
    verifyBoundary(scheduling)
    verifyBoundary(await sourceCopy())
  })

  it('detects a public helper re-export in a source copy with a real assertion failure', async () => {
    const copy = await sourceCopy(true)
    expect(() => verifyBoundary(copy)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })
})
