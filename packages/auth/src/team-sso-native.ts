import type { Db } from '@hourmere/db'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import type { AuthMiddlewareContext } from './api-keys.ts'
import { isMember, isUuid } from './organizations.ts'
import { memoizeTeamSsoAccess, type TeamSsoCapabilities, type TeamSsoSession } from './team-sso.ts'

export function nativeSsoRequired(): never {
  throw new APIError('FORBIDDEN', { code: 'SSO_REQUIRED', message: 'sso_required' })
}

export function trustedAddMember(ctx: { operationId?: unknown }) {
  return ctx.operationId === 'addOrganizationMember'
}

type Context = AuthMiddlewareContext & { operationId?: string }

const slugReads = new Set([
  '/organization/get-organization',
  '/organization/get-full-organization',
  '/organization/list-members',
  '/organization/get-active-member-role',
])
const idReads = new Set(['/organization/list-invitations'])
const idWrites = new Set([
  '/organization/update',
  '/organization/leave',
  '/organization/remove-member',
  '/organization/update-member-role',
  '/organization/has-permission',
])
const invitationTargets = new Set([
  '/organization/get-invitation',
  '/organization/accept-invitation',
  '/organization/reject-invitation',
])
const lists = new Set(['/organization/list', '/organization/list-user-invitations'])

function uuid(value: unknown): string | undefined {
  return typeof value === 'string' && isUuid(value) ? value : undefined
}

function slugId(db: Db, slug: unknown) {
  if (typeof slug !== 'string' || !slug || slug.includes('\u0000')) return undefined
  return db
    .selectFrom('auth.organization')
    .select('id')
    .where('slug', '=', slug)
    .executeTakeFirst()
    .then((organization) => organization?.id)
}

/** Both the HTTP router and the trusted auth.api methods dispatch through these hooks. */
export function nativeTeamSso(db: Db, capabilities: TeamSsoCapabilities) {
  type Check = ReturnType<typeof memoizeTeamSsoAccess>
  const requestChecks = new WeakMap<object, Check>()
  const deniedReads = new WeakSet<object>()
  const checkFor = (ctx: Context, identity: TeamSsoSession | null) => {
    let check = requestChecks.get(ctx.context)
    if (!check) {
      check = memoizeTeamSsoAccess({ db, capabilities }, identity)
      requestChecks.set(ctx.context, check)
    }
    return check
  }
  const sessionIdentity = (session: Awaited<ReturnType<typeof getSessionFromCtx>>) =>
    session ? { sessionId: session.session.id, userId: session.user.id } : null

  return {
    async before(ctx: Context) {
      const path = ctx.path
      const addMember = trustedAddMember(ctx)
      const checkSlug = path === '/organization/check-slug'
      const setActive = path === '/organization/set-active'
      const fromInvitation = invitationTargets.has(path)
      const fromQuery = slugReads.has(path) || idReads.has(path)
      const activeMember = path === '/organization/get-active-member'
      // Creation has no existing target. Invitation issuance and cancellation enforce
      // at their shared service boundary. Aggregate reads filter their native result.
      if (
        !(
          addMember ||
          checkSlug ||
          setActive ||
          fromInvitation ||
          fromQuery ||
          activeMember ||
          idWrites.has(path)
        )
      )
        return
      const body = ctx.body as Record<string, unknown> | undefined
      if (setActive && body?.organizationId === null) return

      // Trusted add-member accepts an explicit team even without headers. Slug
      // availability is also callable without a session by trusted code.
      const session = await getSessionFromCtx(ctx)
      if (!session && !addMember && (!checkSlug || ctx.request || ctx.headers)) return
      const activeId = session?.session.activeOrganizationId
      let organizationId: string | undefined
      if (checkSlug) {
        organizationId = await slugId(db, body?.slug)
      } else if (fromInvitation) {
        const invitationId = uuid(
          path === '/organization/get-invitation' ? ctx.query?.id : body?.invitationId,
        )
        if (!invitationId || !session?.user.emailVerified) return
        const invitation = await db
          .selectFrom('auth.invitation')
          .select('organizationId')
          .where('id', '=', invitationId)
          .where('status', '=', 'pending')
          .where((eb) =>
            eb(eb.fn<string>('lower', ['email']), '=', session.user.email.toLowerCase()),
          )
          .executeTakeFirst()
        organizationId = invitation?.organizationId
      } else if (slugReads.has(path) && ctx.query?.organizationSlug) {
        organizationId = await slugId(db, ctx.query.organizationSlug)
      } else if (setActive && !body?.organizationId && body?.organizationSlug) {
        organizationId = await slugId(db, body.organizationSlug)
      } else {
        const explicitId = fromQuery
          ? ctx.query?.organizationId
          : activeMember
            ? undefined
            : body?.organizationId
        organizationId = uuid(explicitId || activeId)
      }
      if (!organizationId) return
      const access = await checkFor(ctx, sessionIdentity(session))(organizationId)
      if (access.suspended) {
        throw new APIError('FORBIDDEN', {
          code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
          message: 'team_management_access_denied',
        })
      }
      if (!access.allowed) {
        // Keep native membership errors uniform for outsiders probing team selectors.
        // Trusted admission, and an invitation already bound to its verified recipient,
        // have their own scope and require proof even without a current membership.
        if (
          addMember ||
          fromInvitation ||
          (!session && checkSlug) ||
          (session &&
            (await isMember(
              db,
              session.user.id,
              organizationId,
              capabilities.scimResourcesEnabled === true,
            )))
        )
          nativeSsoRequired()
        if (fromQuery || activeMember || path === '/organization/has-permission') {
          // Native denials keep their existing shape. A concurrent admission must
          // not turn the original proof refusal into a successful team read.
          deniedReads.add(ctx.context)
          return { deferred: true }
        }
        return
      }

      // Run slug-selected reads against the exact row whose policy was checked.
      // Otherwise a slug reassigned between the guard and endpoint can select a new team.
      if (slugReads.has(path) && ctx.query?.organizationSlug) {
        return { context: { query: { ...ctx.query, organizationSlug: '', organizationId } } }
      }
    },
    plugin: {
      id: 'team-policy',
      hooks: {
        after: [
          {
            matcher: (ctx) => deniedReads.has(ctx.context),
            handler: createAuthMiddleware(async (ctx) => {
              if (!(ctx.context.returned instanceof APIError)) nativeSsoRequired()
            }),
          },
          {
            matcher: (ctx) => lists.has(ctx.path ?? ''),
            handler: createAuthMiddleware(async (ctx) => {
              const returned = ctx.context.returned
              if (!Array.isArray(returned) || returned.length === 0) return
              const check = checkFor(ctx, sessionIdentity(await getSessionFromCtx(ctx)))
              const access = await Promise.all(
                returned.map((row) =>
                  check(ctx.path === '/organization/list' ? row.id : row.organizationId),
                ),
              )
              if (access.some((result) => !result.allowed))
                return ctx.json(returned.filter((_, index) => access[index]?.allowed))
            }),
          },
        ],
      },
    } satisfies BetterAuthPlugin,
  }
}
