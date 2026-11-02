import { isReservedName } from '@hourmere/core/reserved'
import { cleanText } from '../../scheduling/src/text.ts'
import type {
  MatchedUser,
  PlanProblem,
  SourceRow,
  SourceSnapshot,
  TargetContext,
  TargetUser,
} from './types.ts'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const LOCALE = /^[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8})*$/
export const normalizeEmail = (email: string) => email.trim().toLowerCase()
export function validLocale(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 35 && LOCALE.test(value)
}
export function canonicalTimezone(value: unknown): string | undefined {
  if (typeof value !== 'string' || /^[+-]/.test(value)) return undefined
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone
  } catch {
    return undefined
  }
}
export function validInstant(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  // Source adapters project timestamp without time zone as explicit UTC. No machine zone parsing.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return undefined
  try {
    return Temporal.Instant.from(value).toString({ smallestUnit: 'millisecond' })
  } catch {
    return undefined
  }
}

function identityProblem(
  row: SourceRow,
  sources: SourceRow[],
  targets: readonly TargetUser[],
): string | undefined {
  const email = typeof row.email === 'string' ? normalizeEmail(row.email) : ''
  if (!EMAIL.test(email) || email.length > 254 || !validInstant(row.emailVerified))
    return 'user_source_unverified'
  if (
    sources.filter((s) => typeof s.email === 'string' && normalizeEmail(s.email) === email)
      .length !== 1
  )
    return 'user_source_email_ambiguous'
  const matches = targets.filter((t) => normalizeEmail(t.email) === email)
  if (matches.length !== 1) return matches.length ? 'user_target_email_ambiguous' : 'user_unmatched'
  const target = matches[0]
  if (targets.filter((t) => t.id === target?.id).length !== 1) return 'user_target_id_ambiguous'
  if (!target?.emailVerified) return 'user_target_unverified'
  if (!target.authorized) return 'user_owner_authorization_required'
  if (
    !UUID.test(target.id) ||
    !target.personalOrganizationId ||
    !UUID.test(target.personalOrganizationId)
  )
    return 'user_personal_organization_missing'
}

/** Shared by extraction: dependencies are read only after one-to-one verified identity matching. */
export function matchIdentityRows(rows: SourceRow[], targets: readonly TargetUser[]): number[] {
  return rows
    .filter((row) => Number.isSafeInteger(row.id) && !identityProblem(row, rows, targets))
    .map((row) => row.id as number)
}

export function parseUsers(
  snapshot: SourceSnapshot,
  target: TargetContext,
  problems: PlanProblem[],
): Map<number, MatchedUser> {
  const result = new Map<number, MatchedUser>()
  const rows = snapshot.tables.users ?? []
  for (const id of snapshot.selectedUserIds) {
    const row = rows.find((u) => u.id === id)
    const problem = (
      code: string,
      message: string,
      severity: PlanProblem['severity'] = 'import_blocker',
    ) => problems.push({ code, severity, source: { table: 'users', id }, message })
    if (!row) {
      problem('user_missing', 'The selected source user was not found.')
      continue
    }
    const identityCode = identityProblem(row, rows, target.users)
    if (identityCode) {
      problem(
        identityCode,
        'A unique, verified and owner-authorized existing personal account is required.',
      )
      continue
    }
    if (
      row.organizationId != null ||
      row.movedToProfileId != null ||
      (snapshot.tables.Profile ?? []).some((p) => p.userId === id && p.organizationId != null)
    ) {
      problem(
        'user_organization_scope',
        'Organization-associated identities require manual scope resolution.',
      )
      continue
    }
    const matched = target.users.find(
      (t) => normalizeEmail(t.email) === normalizeEmail(row.email as string),
    ) as TargetUser
    const timezone = canonicalTimezone(row.timeZone)
    if (!timezone) {
      problem('user_timezone_invalid', 'The source user time zone is not a valid IANA time zone.')
      continue
    }
    let profile = matched.profile
    if (!profile) {
      const handle = row.username
      if (
        typeof handle !== 'string' ||
        !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(handle) ||
        isReservedName(handle)
      ) {
        problem(
          'user_handle_invalid',
          'A valid unreserved personal handle must be explicitly chosen.',
        )
        continue
      }
      if (
        target.occupiedHandles.some((h) => h.toLowerCase() === handle) ||
        [...result.values()].some((u) => u.profile.handle === handle)
      ) {
        problem('user_handle_conflict', 'The proposed personal handle is already in use.')
        continue
      }
      if (row.locale != null && !validLocale(row.locale)) {
        problem('user_locale_invalid', 'The source locale is invalid.')
        continue
      }
      if (row.locale == null)
        problem(
          'user_locale_defaulted',
          'An absent source locale is proposed as English.',
          'warning',
        )
      profile = {
        handle,
        timeZone: timezone,
        locale: typeof row.locale === 'string' ? row.locale : 'en',
      }
    }
    result.set(id, {
      sourceId: id,
      targetUserId: matched.id,
      organizationId: matched.personalOrganizationId as string,
      sourceTimezone: timezone,
      profile,
      profileAction: matched.profile ? 'preserve' : 'propose',
    })
    if (row.bufferTime !== 0 && row.bufferTime != null)
      problem(
        'user_buffer_unmapped',
        'The source user buffer is not added to event buffers and requires review.',
        'activation_blocker',
      )
    problem(
      'user_display_settings_preserved',
      'Existing target identity and display settings are preserved; source branding and display preferences are not imported.',
      'warning',
    )
    if ((snapshot.tables.Membership ?? []).some((m) => m.userId === id))
      problem(
        'team_membership_excluded',
        'Source team memberships and their permissions are excluded.',
        'excluded',
      )
  }
  return result
}

export function validateTargetContext(value: unknown): value is TargetContext {
  if (!value || typeof value !== 'object') return false
  const t = value as TargetContext
  if (
    !Array.isArray(t.users) ||
    !Array.isArray(t.occupiedHandles) ||
    !Array.isArray(t.occupiedSlugs) ||
    !Array.isArray(t.busy)
  )
    return false
  return (
    t.users.every(
      (u) =>
        u &&
        typeof u.email === 'string' &&
        !!cleanText(u.email, { max: 254 }) &&
        UUID.test(u.id) &&
        typeof u.emailVerified === 'boolean' &&
        typeof u.authorized === 'boolean' &&
        (u.personalOrganizationId === null || UUID.test(u.personalOrganizationId)) &&
        (u.profile === undefined ||
          (typeof u.profile.handle === 'string' &&
            !!canonicalTimezone(u.profile.timeZone) &&
            validLocale(u.profile.locale))),
    ) &&
    t.occupiedHandles.every((h) => typeof h === 'string') &&
    t.occupiedSlugs.every((s) => s && UUID.test(s.organizationId) && typeof s.slug === 'string') &&
    t.busy.every(
      (b) =>
        b &&
        UUID.test(b.targetUserId) &&
        !!validInstant(b.start) &&
        !!validInstant(b.end) &&
        Temporal.Instant.compare(b.start, b.end) < 0,
    )
  )
}
