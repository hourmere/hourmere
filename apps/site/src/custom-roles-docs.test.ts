import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { apiKeyOperation } from '../../../packages/auth/src/api-key-operations.ts'
import { fixedTeamRole } from '../../../packages/auth/src/team-role-policy.ts'

const root = process.env.HOURMERE_DOCS_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const design = read('docs/custom-roles.md')
const prose = design.replace(/\s+/g, ' ')

function row(label: string) {
  const line = design.split('\n').find((line) => line.startsWith(`| ${label} |`))
  expect(line, `Catalogue row for ${label}`).toBeDefined()
  return line as string
}

describe('custom roles design facts', () => {
  it('links the proposal from the current team and permissions guides', () => {
    expect(design).toContain('Proposed design. Custom roles are unavailable today.')
    expect(read('README.md')).toContain('](docs/custom-roles.md)')
    expect(read('docs/member-leave.md')).toContain('](custom-roles.md)')
    expect(read('apps/site/src/content/docs/docs/api-conventions.md')).toContain(
      '](https://github.com/hourmere/hourmere/blob/main/docs/custom-roles.md)',
    )
  })

  it('keeps native assignment and owner continuity outside the custom catalogue', () => {
    expect(['owner', 'scheduler', 'member,admin'].map(fixedTeamRole)).toEqual([
      undefined,
      undefined,
      undefined,
    ])
    expect(['admin', 'member'].map(fixedTeamRole)).toEqual(['admin', 'member'])
    expect(read('packages/auth/src/team-role-policy.ts')).toContain(
      "target.userId === facts.userId || teamRoles(target.role).includes('owner')",
    )
    expect(read('packages/auth/src/team-owner-continuity.ts')).toContain(
      "teamRoles(member.role).includes('owner')",
    )
    expect(row('Member roles and removal')).toMatch(/\*\*Fixed\*\* `members\.assign_role`/)
    expect(prose).toMatch(
      /same organization `FOR UPDATE` lock.*last-Owner count and last-recovery-owner guard/,
    )
  })

  it('keeps team booking administration session-only and distinct from assigned-host access', () => {
    for (const operation of [
      'GET /api/v1/team/bookings',
      'GET /api/v1/team/bookings/{id}',
      'POST /api/v1/team/bookings/{id}/cancel',
      'GET /api/v1/bookings/{id}/organization',
    ]) {
      expect(apiKeyOperation(operation)).toMatchObject({
        authentication: 'session_only',
        allowedScopes: [],
      })
    }
    expect(apiKeyOperation('GET /api/v1/bookings/{id}')).toMatchObject({
      allowedScopes: ['full', 'read', 'bookings'],
    })
    expect(row('Team bookings and CSV')).toMatch(
      /\*\*Custom\*\* `team_bookings\.read`.*\*\*Fixed\*\* `team_bookings\.cancel`, `team_bookings\.export`/,
    )
    expect(row('Attendance, no-shows and group occurrences')).toContain('distinct host path only')
  })

  it('retains owner-only audit settings and the scope registry across interfaces', () => {
    for (const operation of [
      'GET /api/v1/audit-events',
      'PUT /api/v1/audit-log/settings',
      'mcp:set_audit_log_settings',
      'cli:audit-log set-retention',
      'POST /api/v1/routing-forms/{id}/preview',
    ]) {
      expect(apiKeyOperation(operation)?.allowedScopes, operation).toEqual(['full'])
    }
    expect(read('packages/scheduling/src/audit-log.ts')).toContain("if (role !== 'owner')")
    expect(row('Audit journal')).toMatch(
      /Only Owner changes retention.*\*\*Fixed\*\* `audit\.read`, `audit\.read_retention`, `audit\.update_retention`/,
    )
    expect(row('Routing forms')).toContain('full-key boundary')
  })

  it('keeps identity authority outside custom grants and provisioning issuance browser-only', () => {
    for (const operation of [
      'POST /api/v1/organizations/{organizationId}/provisioning-tokens',
      'POST /api/v1/organizations/{organizationId}/provisioning-tokens/{id}/rotate',
      'POST /api/v1/scim/team-mappings/consent',
    ]) {
      expect(apiKeyOperation(operation)).toMatchObject({
        authentication: 'session_only',
        allowedScopes: [],
      })
    }
    const identity = design.split('### Identity, directory and credential operations')[1]
    expect(identity?.split('## Role model and safe writes')[0]).toContain(
      'All rows in this table are **Fixed**.',
    )
    expect(
      row('`sso.activate_provider`, `sso.deactivate_provider`, `sso.set_enforcement`'),
    ).toContain('Only fixed Owner')
    expect(
      row('`scim.read_tokens`, `scim.revoke_token`, `scim.create_token`, `scim.rotate_token`'),
    ).toContain('Only fixed browser Owner creates or rotates')
  })

  it('documents the paid booking boundary and preserves the existing refund effect', () => {
    expect(read('docs/payments.md')).toContain('price settings and automatic Stripe Session expiry')
    expect(read('packages/scheduling/src/bookings.ts')).toContain('ensurePaymentRefund(')
    expect(row('Billing and booking payments')).toContain(
      'The deployed paid-admission path remains off',
    )
    expect(row('Billing and booking payments')).toContain('No `billing.*` or `payments.*` grant')
  })

  it('pins legacy credential ceilings through renewal and use', () => {
    expect(prose).toMatch(/frozen manifest of pre-custom operations.*until explicit renewal/)
    expect(prose).toContain("credential's issued ceiling explicitly contains it")
    expect(row('Browser session')).toContain('rolling expiry cannot confer greater authority')
    expect(row('API key')).toContain('replacement with a new ID and pinned ceiling')
    expect(row('MCP OAuth')).toContain('Refresh keeps the original ceiling')
    expect(row('SCIM token')).toContain('ordinary secret rotation cannot add an action')
    expect(prose).toContain(
      'Reject key retargeting if either the old or requested organization has activated',
    )
    expect(prose).toContain('Advance the policy epoch on both disable and re-enable.')
  })

  it('keeps the first two implementation rows hard-off and gates rollout on final acceptance', () => {
    expect(row('Storage and migration · about one day')).toContain(
      'Land with custom roles hard-off.',
    )
    expect(row('Server resolution and safe writes · about one day')).toContain(
      'Land with custom roles hard-off.',
    )
    expect(row('UI and cross-interface acceptance · about one day')).toContain(
      'Keep hard-off until this row is accepted and the lead explicitly authorizes rollout.',
    )
  })
})
