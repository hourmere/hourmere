export interface RecoveryNomination {
  enrollmentId: string
  organizationId: string
  expectedRevision: number
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function hasRecoveryNomination(hash: string) {
  return new URLSearchParams(hash.slice(1)).has('ssoRecoveryEnrollment')
}

export function parseRecoveryNomination(hash: string): RecoveryNomination | null {
  const values = new URLSearchParams(hash.slice(1))
  const enrollmentId = values.get('ssoRecoveryEnrollment')
  const organizationId = values.get('organizationId')
  const revision = values.get('expectedRevision')
  if (
    values.size !== 3 ||
    !enrollmentId ||
    !uuid.test(enrollmentId) ||
    !organizationId ||
    !uuid.test(organizationId) ||
    !revision ||
    !/^[1-9][0-9]{0,9}$/.test(revision)
  )
    return null
  const expectedRevision = Number(revision)
  if (expectedRevision > 2_147_483_646) return null
  return {
    enrollmentId: enrollmentId.toLowerCase(),
    organizationId: organizationId.toLowerCase(),
    expectedRevision,
  }
}
