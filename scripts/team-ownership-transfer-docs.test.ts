import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const document = readFileSync(
  new URL('../docs/team-ownership-transfer.md', import.meta.url),
  'utf8',
)

function section(heading: string) {
  return (document.split(`\n## ${heading}\n`)[1]?.split('\n## ')[0] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

it('requires a verified owner to initiate and only the named verified member to confirm', () => {
  const permissions = section('Decisions and permissions')
  expect(permissions).toContain('| Create | A current, email-verified owner of the active team |')
  expect(permissions).toContain(
    'Offer ownership to a different, current, email-verified `admin` or `member` of that same team.',
  )
  expect(permissions).toContain(
    '| Confirm | The named recipient alone, through their current, email-verified membership in the active team |',
  )
  expect(permissions).toContain(
    'set the recipient to `owner` and the initiating owner to `admin` atomically.',
  )
})

it('lets other verified owners revoke within 24 hours without participant details or role changes', () => {
  const permissions = section('Decisions and permissions')
  expect(permissions).toMatch(/\| Revoke \| Any current, email-verified owner[^|]*\|/)
  expect(permissions).toContain(
    'Revoke the pending offer before its deadline, without changing any roles.',
  )
  expect(permissions).toContain(
    'Other current, email-verified owners see only its ID, deadline and the revoke action.',
  )
  expect(permissions).toContain(
    'An owner acting only as revoker receives no participant identities.',
  )
  const transaction = section('Data model and transaction')
  expect(transaction).toContain('An offer expires 24 hours after creation on the database clock.')
  expect(transaction).toContain(
    'Confirmation and revocation require `clock_timestamp() < expires_at` after lock waits.',
  )
})

it('requires fresh proof for create and confirm, bound to the operation and input', () => {
  const proof = section('Fresh proof')
  expect(proof).toContain('Create and confirm use the shared `runWithFreshProof` gate')
  expect(proof).toContain('mailbox proof for teams without SSO enforcement')
  expect(proof).toContain('SSO step-up for enforced teams')
  expect(proof).toContain('team, operation and canonical input digest')
  expect(proof).toContain(
    'the target membership ID for create and the transfer ID from the path for confirm',
  )
  expect(proof).toContain('retry the same operation and input with `proofAttemptId`')
  expect(proof).toContain(
    'Revoke uses the live verified owner session and ordinary team SSO checks without fresh proof.',
  )
  expect(section('Failure modes')).toContain('`403 sso_reauthentication_required`')

  const plan = section('Test plan')
  expect(plan).toContain('expired proof')
  expect(plan).toContain('mismatched input digest')
  expect(plan).toContain('mailbox-only proof on an enforced team')
  expect(plan).toContain(
    'Complete mailbox proof with both SSO protocols off on a non-enforced team',
  )
})

it('refuses an initiator whose owner membership is SCIM-managed', () => {
  const failures = section('Failure modes')
  expect(failures).toContain(
    "The initiator's owner membership is SCIM-managed | Refuse creation with `409 scim_managed_resource`",
  )
  expect(failures).toContain(
    'If either bound membership becomes SCIM-managed after creation, invalidate the offer',
  )
  expect(section('Decisions and permissions')).toContain(
    'Reject both direct SCIM directory links and SCIM-managed child memberships, including while provisioning is disabled.',
  )
})

it('commits the transfer audit trail and notification jobs with lifecycle writes', () => {
  const audit = section('Audit, notifications and rate limits')
  for (const action of ['offered', 'revoked', 'expired', 'invalidated']) {
    expect(audit).toContain(`\`organization.ownership_transfer_${action}\``)
  }
  expect(audit).toContain('confirming transaction, write `organization.ownership_transferred`')
  expect(audit).toContain(
    '`membership.role_changed` for both memberships, each targeted by its membership ID with `oldRole` and `newRole`',
  )
  expect(audit).toContain(
    'Queue a notification to the target on creation and to all current owners after promotion and to the former owner on confirmation, once per recipient.',
  )
  expect(audit).toContain(
    'in the same transaction as the roles, recovery cleanup, proof consumption, offer state and audit events',
  )
  expect(audit).toContain('the existing admin-language mail pattern')
  expect(audit).toContain('carry no offer IDs or confirmation credentials')
  expect(audit).toContain('Rate-limit create and revoke per team using separate durable budgets')
  expect(audit).toContain('allow at least one more revocation than creation per window')
})

it('voids pending SSO recovery nominations involving the initiator when confirming', () => {
  expect(section('Decisions and permissions')).toContain(
    'In the confirming transaction, void pending SSO recovery nominations where the initiator is either the nominator or the nominee in this team',
  )
  expect(section('Test plan')).toContain('regaining ownership cannot revive a voided nomination')
})

it('keeps personal calendars and provider authorizations with their original users', () => {
  expect(section('Decisions and permissions')).toContain(
    'Personal spaces, personal calendars and provider authorizations stay with their original users. That includes Google, Microsoft and CalDAV calendar connections and Zoom authorization.',
  )
})

it('preserves resource ownership and applies the new role to already-open sessions', () => {
  const resources = section('Decisions and permissions')
  expect(resources).toContain(
    'SSO delegation bindings stay tied to their existing credentials and identity links.',
  )
  expect(resources).toContain(
    'Team-owned webhook endpoints, Slack connections, routing forms, workflows and SCIM provisioning tokens stay with the team and retain their creator attribution.',
  )
  expect(resources).toContain(
    'Payments and Stripe configuration are instance-level and unaffected.',
  )
  expect(resources).toContain(
    'Owner-only capabilities move with the owner role, including SCIM provisioning token issue and rotation, SSO recovery nomination and SSO enforcement changes.',
  )
  expect(section('Test plan')).toContain(
    'the old owner immediately loses owner-only operations, including from already-open sessions.',
  )
})

it('plans REST and interface parity separately from bilingual browser acceptance', () => {
  const steps = section('One-day implementation steps')
  expect(steps).toMatch(/\| REST and interface parity \|[^|]*OpenAPI[^|]*Postgres[^|]*\|/)
  expect(steps).toMatch(
    /\| Bilingual UI and two-party browser acceptance \|[^|]*en[^|]*zh-CN[^|]*jsdom[^|]*credential exclusions[^|]*\|/,
  )
})
