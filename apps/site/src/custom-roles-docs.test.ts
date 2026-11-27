import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { apiKeyOperation } from '../../../packages/auth/src/api-key-operations.ts'
import { fixedTeamRole } from '../../../packages/auth/src/team-role-policy.ts'
import {
  customRoleCatalogueV1,
  isCustomRolePermission,
} from '../../../packages/core/src/custom-role-catalogue.ts'

const root = process.env.HOURMERE_DOCS_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const design = read('docs/custom-roles.md')
const asProse = (text: string) => text.replace(/\s+/g, ' ')
const prose = asProse(design)

function section(heading: string) {
  const start = design.indexOf(`${heading}\n`)
  expect(start, `Section ${heading}`).toBeGreaterThanOrEqual(0)
  return design.slice(start + heading.length + 1).split(/^#{1,3} /m)[0] ?? ''
}

function row(label: string) {
  const line = design.split('\n').find((line) => line.startsWith(`| ${label} |`))
  expect(line, `Table row for ${label}`).toBeDefined()
  return line as string
}

function permissionIds(text: string) {
  return (text.match(/`[a-z0-9_.]+`/g) ?? []).map((id) => id.slice(1, -1))
}

function classifiedPermissionIds(catalogue: string, classification: string) {
  return [...catalogue.matchAll(/\*\*(Fixed|Custom \([^)]+\))\*\* ((?:`[a-z0-9_.]+`(?:, )?)+)/g)]
    .filter((match) => match[1] === classification)
    .flatMap((match) => permissionIds(match[2] ?? ''))
    .sort()
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

  it('clears a custom assignment atomically when the recipient confirms ownership transfer', () => {
    const roleModel = asProse(section('## Role model and safe writes'))
    expect(roleModel).toContain('https://github.com/hourmere/hourmere/pull/599)')
    expect(roleModel).toContain(
      'If a member with a custom assignment confirms an ownership transfer, clear their custom assignment, advance their authorization generation and audit the change in the same transaction as the Owner promotion.',
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
      /\*\*Custom \(phase two, personal data\)\*\* `team_bookings\.read`.*\*\*Fixed\*\* `team_bookings\.cancel`, `team_bookings\.export`/,
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
    const paymentDocs = asProse(read('docs/payments.md'))
    const billing = row('Billing and booking payments')
    expect(paymentDocs).toContain(
      'New paid admission defaults to off and live admission remains closed.',
    )
    expect(paymentDocs).toContain(
      'Automatic Stripe Session expiry on local release remains later work.',
    )
    expect(read('packages/scheduling/src/bookings.ts')).toContain('ensurePaymentRefund(')
    expect(billing).toContain(
      'Price settings and Stripe Checkout are limited to eligible personal event types.',
    )
    expect(billing).toContain(
      'Test-mode admission defaults to off and live admission remains closed.',
    )
    expect(billing).toContain('No `billing.*` or `payments.*` grant')
  })

  it('pins legacy credential ceilings through renewal and use', () => {
    expect(prose).toMatch(/frozen manifest of pre-custom operations.*until explicit renewal/)
    expect(prose).toContain("credential's issued ceiling explicitly contains it")
    expect(row('Browser session')).toContain('rolling expiry cannot confer greater authority')
    expect(row('API key')).toContain('replacement with a new ID and pinned ceiling')
    expect(row('MCP OAuth')).toContain('Refresh keeps the original ceiling')
    expect(row('SCIM token')).toContain('ordinary secret rotation cannot add an action')
    expect(prose).toContain(
      'Reject key retargeting when either the old or requested binding is subject to a custom-assignment version boundary',
    )
    expect(prose).toContain('Advance the policy epoch on both disable and re-enable.')
  })

  it('bounds reauthorization to custom assignments and preserves fixed-role credentials', () => {
    const versions = asProse(section('## Storage, migration and credential versions'))
    expect(versions).toContain(
      'A version-bound team operation is an operation authorized through a custom grant.',
    )
    expect(versions).toContain(
      'Fixed roles keep their current decision path and credentials across enable, disable and re-enable.',
    )
    expect(versions).toContain(
      'Existing fixed-role browser sessions, API keys, OAuth grants and integrations, including Zapier and n8n, continue to authorize the same operations without renewal.',
    )
    expect(versions).toContain(
      'Apply the version boundary only to memberships with a custom assignment change.',
    )
    expect(versions).toContain(
      "A credential issued before the member's current authorization generation can lose access, but cannot gain it.",
    )
    expect(versions).toContain(
      'A credential issued before assignment clearance requires explicit renewal for newly acquired fixed Admin or Owner authority, including after a later, separate promotion.',
    )
    expect(versions).toContain(
      'Fixed-role promotions, ownership transfer, departure and SCIM revocation still clear dormant assignments and advance the affected authorization generation in the same transaction while either switch is off.',
    )
    expect(row('Fixed-role compatibility')).toContain(
      'Verify existing fixed-role sessions, all key scopes, OAuth grants and Zapier/n8n integrations keep working across enable, disable and re-enable without renewal.',
    )
  })

  it('limits the first phase to scheduling coordinators and marks second-phase personal data', () => {
    const catalogue = section('## Current gates and proposed catalogue')
    const customLabels = [...design.matchAll(/\*\*(Custom[^*]*)\*\* `/g)].map((match) => match[1])
    expect(new Set(customLabels)).toEqual(
      new Set(['Custom (phase one)', 'Custom (phase two, personal data)']),
    )
    expect(classifiedPermissionIds(catalogue, 'Custom (phase one)')).toEqual(
      customRoleCatalogueV1.phaseOne,
    )
    expect(classifiedPermissionIds(catalogue, 'Custom (phase two, personal data)')).toEqual(
      customRoleCatalogueV1.phaseTwoPersonalData,
    )
    expect(asProse(catalogue)).toContain(
      'For phase-one event type creation and duplication, a disabled waitlist and absent redirect are neutral defaults. Enabling a waitlist or setting a redirect, including when copied from the source event type, requires its separate authorization.',
    )
    expect(row('Branding and booking activity')).toContain('aggregate booking analytics')
    const interfaces = asProse(section('## Interfaces and acceptance'))
    expect(interfaces).toContain(
      'group its personal-data permissions separately in the editor and assignment preview under **Personal data / 个人数据**.',
    )
    expect(interfaces).toContain(
      'Record the personal-data permission IDs in assignment and clearance events when the role includes them.',
    )
  })

  it('recognizes only explicit custom permission IDs in the frozen catalogue version', () => {
    const catalogue = section('## Current gates and proposed catalogue')
    const identity = section('### Identity, directory and credential operations')
    const identityIds = [...identity.matchAll(/^\| (`[^|]+) \|/gm)].flatMap((match) =>
      permissionIds(match[1] ?? ''),
    )
    const { version, fixed, phaseOne, phaseTwoPersonalData } = customRoleCatalogueV1
    expect(version).toBe(1)
    expect(fixed).toEqual([...classifiedPermissionIds(catalogue, 'Fixed'), ...identityIds].sort())
    for (const id of [...phaseOne, ...phaseTwoPersonalData]) {
      expect(isCustomRolePermission(version, id), id).toBe(true)
      expect(isCustomRolePermission(version + 1, id), id).toBe(false)
    }
    for (const id of [...fixed, '*', 'event_types.*', 'analytics.future', 'ANALYTICS.READ']) {
      expect(isCustomRolePermission(version, id), id).toBe(false)
    }
  })

  it('defaults uncatalogued operations to their current checks and requires registry coverage', () => {
    expect(asProse(section('## Current gates and proposed catalogue'))).toContain(
      'An operation missing from the catalogue always uses its current fixed-role or relationship check.',
    )
    const engine = row('Resolution engine and versioned reads · about one day')
    expect(engine).toContain('`GET /permissions`')
    expect(engine).toMatch(/every team-(?:scoped|gated) operation/i)
    for (const registry of ['api-key-operations.ts', 'MCP tool list', 'session-only routes']) {
      expect(engine).toContain(registry)
    }
    expect(engine).toMatch(/Fixed.*Custom/)
  })

  it('keeps role management and owner opt-in on browser REST with a default-off master switch', () => {
    const versions = asProse(section('## Storage, migration and credential versions'))
    expect(versions).toContain(
      "The instance-wide master switch and each team's custom roles setting default to off.",
    )
    expect(versions).toContain(
      'Only a freshly verified fixed Owner can enable or disable custom roles for a team through browser REST.',
    )
    const interfaces = asProse(section('## Interfaces and acceptance'))
    expect(interfaces).toContain(
      'Role definitions, assignments and team enablement are managed only through browser REST by a freshly verified fixed Owner.',
    )
    expect(interfaces).toContain(
      'API keys, MCP and CLI cannot manage role definitions, assignments or team enablement.',
    )
    expect(interfaces).toContain(
      'A later release may expose only read-only self-permissions to MCP and CLI.',
    )
  })

  it('splits implementation into hard-off steps and gates rollout on final acceptance', () => {
    const steps = [
      'Storage and migration',
      'Resolution engine and versioned reads',
      'Role and assignment writes',
      'Phase-one grants wired into services',
      'Credential ceilings and enable flow',
      'Edit and assignment UI',
      'Cross-interface and browser acceptance',
    ].map((step) => `${step} · about one day`)
    const plan = section('### Implementation follow-ups')
    const plannedSteps = [...plan.matchAll(/^\| ([^|]+) \|/gm)].slice(2).map((match) => match[1])
    expect(plannedSteps).toEqual(steps)
    for (const step of steps) expect(row(step)).toContain('Land with custom roles hard-off.')
    expect(row('Cross-interface and browser acceptance · about one day')).toContain(
      'Keep hard-off until this row is accepted and the lead explicitly authorizes rollout.',
    )
  })
})
