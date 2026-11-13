import { describe, expect, it } from 'vitest'
import { assertScimTokenActorProtections } from './audit-scim-token-actor-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('SCIM provisioning token actor constraint coverage', () => {
  it('fails a protection assertion when any object created by 0082 is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration: '0082_audit_scim_token_actor.sql',
      assertions: assertScimTokenActorProtections,
    })
    expect(report.problems).toEqual([])
    expect(report.objects.map((object) => object.key)).toEqual([
      'constraint public.audit_events.audit_events_actor_type_check',
      'constraint public.audit_events.audit_scim_token_actor_credential',
    ])
    expect(report.results.map((result) => result.status)).toEqual(['covered', 'covered'])
  }, 600_000)
})
