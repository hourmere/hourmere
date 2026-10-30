import type { Db } from '@hourmere/db'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { type AuthMiddlewareContext, apiKeyRules } from './api-keys.ts'
import { displayNameRules } from './display-name.ts'
import {
  type EnqueueInvitationEmail,
  invitationRules,
  type ReserveInvitationEmail,
} from './invitations.ts'
import { checkListQuery, emptyMemberList } from './lists.ts'
import { defaultMagicLinkErrorRedirect } from './magic-link.ts'
import { organizationContext } from './organization-context.ts'
import { isUuid, personalOwner } from './organizations.ts'
import { fixedTeamRole, teamRoleDenied } from './team-role-policy.ts'

/** Request fields that Better Auth looks up in uuid columns. */
const ID_FIELDS = ['id', 'userId', 'organizationId', 'memberId', 'invitationId', 'keyId']

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const SOCIAL_AUTHORIZATION_FIELDS = new Set([
  'provider',
  'callbackURL',
  'errorCallbackURL',
  'newUserCallbackURL',
  'disableRedirect',
])

/** Keep the provider grant fixed even when a caller bypasses the web UI. */
function requireSocialAuthorizationRequest(ctx: AuthMiddlewareContext) {
  if (ctx.path !== '/sign-in/social' && ctx.path !== '/link-social') return
  // Better Auth runs this hook before its endpoint schema strips unknown fields. Check
  // presence, including empty/null values, rather than maintaining a parameter denylist.
  const unsupportedBody =
    isRecord(ctx.body) &&
    Object.keys(ctx.body).some(
      (key) =>
        !SOCIAL_AUTHORIZATION_FIELDS.has(key) &&
        // Trusted server APIs retain direct-token authentication; HTTP uses redirects only.
        !(!ctx.request && key === 'idToken'),
    )
  const unsupportedQuery = isRecord(ctx.query) && Object.keys(ctx.query).length > 0
  if (unsupportedBody || unsupportedQuery) {
    throw new APIError('BAD_REQUEST', {
      code: 'UNSUPPORTED_SOCIAL_AUTHORIZATION_PARAMETERS',
      message: 'Custom social authorization parameters are not supported',
    })
  }
  if (!ctx.request) return
  // Better Auth's default origin check skips requests without cookies. Starting login
  // still creates OAuth state/cookies, so require the same origin even on a first visit.
  const origin = ctx.request.headers.get('origin')
  if (!origin || origin === 'null') {
    throw new APIError('FORBIDDEN', {
      code: 'MISSING_OR_NULL_ORIGIN',
      message: 'A same-origin request is required',
    })
  }
  if (origin !== new URL(ctx.context.baseURL).origin) {
    throw new APIError('FORBIDDEN', {
      code: 'INVALID_ORIGIN',
      message: 'A same-origin request is required',
    })
  }
}

/**
 * Answers 400 for an id that is not a UUID. Better Auth would pass it to Postgres, which
 * fails and echoes the value back in its error: a 500, and attacker-chosen text in the log.
 */
function requireUuidIds(source: unknown) {
  if (!isRecord(source)) return
  const invalid = (field: string) =>
    new APIError('BAD_REQUEST', { code: 'INVALID_ID', message: `${field} must be a UUID` })
  for (const field of ID_FIELDS) {
    const value = source[field]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string' || !isUuid(value)) throw invalid(field)
  }
  // An email address or a member id.
  const memberIdOrEmail = source.memberIdOrEmail
  if (typeof memberIdOrEmail === 'string' && !memberIdOrEmail.includes('@')) {
    if (!isUuid(memberIdOrEmail)) throw invalid('memberIdOrEmail')
  }
}

/**
 * Better Auth's organization plugin has no hook for leaving. Its own rule (the only owner
 * cannot leave) protects a personal organization only while nobody else is an owner, which
 * the other guards ensure for new data but which old or hand-made rows could break.
 */
async function personalOwnerStays(ctx: AuthMiddlewareContext, db: Db) {
  if (ctx.path !== '/organization/leave' || !isRecord(ctx.body)) return
  const organizationId = ctx.body.organizationId
  if (typeof organizationId !== 'string') return
  const session = await getSessionFromCtx(ctx)
  if (session && (await personalOwner(db, organizationId)) === session.user.id) {
    throw new APIError('FORBIDDEN', {
      code: 'PERSONAL_ORGANIZATION',
      message: 'Nobody can leave their own personal organization',
    })
  }
}

/** Agent credentials never inherit browser organization privileges from a cookie. */
function requireOrganizationSession(ctx: AuthMiddlewareContext) {
  if (
    ctx.request?.headers.has('authorization') &&
    (ctx.path === '/organization' || ctx.path.startsWith('/organization/'))
  ) {
    throw new APIError('FORBIDDEN', {
      code: 'SESSION_REQUIRED',
      message: 'Organization management requires a browser session without Authorization',
    })
  }
}

/** Better Auth's `hooks.before`: checks that apply across its endpoints. */
export function beforeHook(
  db: Db,
  teamRolePolicy: (ctx: AuthMiddlewareContext) => Promise<void>,
  reserveInvitationEmail?: ReserveInvitationEmail,
  enqueueInvitationEmail?: EnqueueInvitationEmail,
) {
  return createAuthMiddleware(async (ctx) => {
    requireOrganizationSession(ctx)
    requireSocialAuthorizationRequest(ctx)
    requireUuidIds(ctx.query)
    if (ctx.path === '/organization/update-member-role' && isRecord(ctx.body)) {
      // Role targets share one denial for malformed, missing and other-team identifiers.
      const { memberId: _target, ...otherIds } = ctx.body
      requireUuidIds(otherIds)
    } else {
      requireUuidIds(ctx.body)
    }
    // Better Auth intentionally exposes addMember only as a trusted server API. Its
    // pathless operation still must not create elevated memberships in existing teams.
    if (
      (ctx as { operationId?: string }).operationId === 'addOrganizationMember' &&
      fixedTeamRole(isRecord(ctx.body) ? ctx.body.role : undefined) !== 'member'
    ) {
      throw teamRoleDenied()
    }
    const invitation = await invitationRules(
      ctx,
      db,
      reserveInvitationEmail,
      enqueueInvitationEmail,
    )
    if (invitation) return invitation
    await organizationContext(ctx, db)
    await teamRolePolicy(ctx)
    const filter = checkListQuery(ctx.path, ctx.query)
    const empty = await emptyMemberList(ctx, db, filter)
    if (empty) return empty
    await personalOwnerStays(ctx, db)
    return defaultMagicLinkErrorRedirect(ctx) ?? displayNameRules(ctx) ?? apiKeyRules(ctx, db)
  })
}
