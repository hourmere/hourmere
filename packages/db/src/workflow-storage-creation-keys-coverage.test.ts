import { describe, expect, it } from 'vitest'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import {
  assertCreationKeyProtections,
  creationKeyMigration,
} from './workflow-storage-creation-keys-protections.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('workflow creation key storage constraint coverage', () => {
  it('fails a protection assertion when any object created by 0087 is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration: creationKeyMigration,
      assertions: assertCreationKeyProtections,
    })
    expect(report.problems).toEqual([])
    expect(report.objects.map((object) => object.key).sort()).toEqual([
      'constraint public.workflow_creation_keys.workflow_creation_keys_credential',
      'constraint public.workflow_creation_keys.workflow_creation_keys_fingerprint_length',
      'constraint public.workflow_creation_keys.workflow_creation_keys_key_format',
      'constraint public.workflow_creation_keys.workflow_creation_keys_pkey',
      'constraint public.workflow_creation_keys.workflow_creation_keys_scope',
      'constraint public.workflow_creation_keys.workflow_creation_keys_workflow',
      'not_null public.workflow_creation_keys.actor_user_id',
      'not_null public.workflow_creation_keys.created_at',
      'not_null public.workflow_creation_keys.credential_kind',
      'not_null public.workflow_creation_keys.idempotency_key',
      'not_null public.workflow_creation_keys.request_fingerprint',
      'trigger public.workflow_creation_keys.workflow_creation_keys_guard',
    ])
    expect(report.results.map((result) => result.status)).toEqual(Array(12).fill('covered'))
  }, 600_000)
})
