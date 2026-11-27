import { createRoute, z } from '@hono/zod-openapi'
import {
  type CustomRoleCommand,
  CustomRoleWriteError,
  canReadPrivateTeamRoster,
  checkTeamManagementAccess,
  customRoleWrite,
  lockTeamSsoProof,
  type Principal,
  readCustomRoles,
  resolveTeamPermissions,
  TeamManagementError,
  type TeamPermissionCheck,
  teamRoles,
} from '@hourmere/auth'
import { customRoleCatalogueV1 } from '@hourmere/core'
import { DomainError } from '@hourmere/scheduling'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { CallerEnv } from '../caller.ts'
import { ErrorBody, json, type RouteModule } from '../openapi.ts'
import { type FreshProofDeps, runWithFreshProof } from '../sso-fresh-proof.ts'
import {
  EXPECTED_ORGANIZATION_HEADER,
  organizationContextWriteLock,
  teamManagementSessionCaller,
} from '../team-management.ts'
import { FreshProofChallenge } from './sso-drafts.ts'

const teamPath = '/api/v1/teams/{teamId}' as const
const teamParams = z.object({ teamId: z.uuid() })
const roleParams = teamParams.extend({ roleId: z.uuid() })
const memberParams = teamParams.extend({ memberId: z.uuid() })
const revision = z.number().int().min(1).max(2_147_483_647)
const epoch = z.number().int().min(0).max(2_147_483_647)
const phaseOne: ReadonlySet<string> = new Set(customRoleCatalogueV1.phaseOne)
const permissionId = z
  .string()
  .refine((id) => phaseOne.has(id))
  .openapi({
    description: 'An explicit operation ID grantable in the first custom-role catalogue.',
  })
const definition = z.strictObject({
  name: z.string().trim().min(1).max(100),
  permissionIds: z.array(permissionId).max(customRoleCatalogueV1.phaseOne.length),
})
const publication = definition.extend({ expectedRevision: revision })
const archive = z.strictObject({ expectedRevision: revision })
const assignment = z.strictObject({
  expectedGeneration: revision,
  roleId: z.uuid().nullable(),
  expectedRevision: revision.nullable(),
})
const proofAttempt = { proofAttemptId: z.uuid().optional() }
const headers = z.object({
  'X-Expected-Organization-Id': z.string().optional().openapi({
    description: 'Required on writes. Identifies the team in which the edit began.',
  }),
})

const roleView = z
  .object({
    id: z.uuid(),
    revision,
    name: z.string(),
    catalogueVersion: z.number().int(),
    permissionIds: z.array(z.string()),
    archived: z.boolean(),
  })
  .openapi('CustomTeamRole')
const assignmentView = z
  .object({
    kind: z.string(),
    memberId: z.uuid(),
    generation: revision,
    roleId: z.uuid().nullable(),
    revision: revision.nullable(),
  })
  .openapi('CustomTeamRoleAssignment')
const mutationResult = z.union([z.object({ kind: z.string(), role: roleView }), assignmentView])
const permissionView = z
  .object({
    decisions: z.array(
      z.object({
        operation: z.string(),
        allowed: z.boolean(),
        source: z.string().nullable(),
      }),
    ),
    membershipGeneration: revision.nullable(),
    policyVersion: z.object({ masterEpoch: epoch, teamEpoch: epoch }).nullable(),
  })
  .openapi('TeamPermissions')

const denied = () => new DomainError('forbidden', 'team_management_access_denied')
const disabled = () => new DomainError('not_found', 'custom_roles_disabled')
const errors = {
  400: { description: 'Invalid request', content: json(ErrorBody) },
  403: { description: 'Team management access denied', content: json(ErrorBody) },
  404: { description: 'Custom roles unavailable', content: json(ErrorBody) },
  409: { description: 'Team context changed', content: json(ErrorBody) },
}
const writeErrors = {
  ...errors,
  403: {
    description: 'Team management access denied or fresh verification required',
    content: json(z.union([FreshProofChallenge, ErrorBody])),
  },
  409: {
    description: 'Team context changed, role revision conflict or role in use',
    content: json(ErrorBody),
  },
}

function translate(error: unknown): never {
  if (error instanceof TeamManagementError)
    throw error.code === 'organization_context_changed'
      ? new DomainError('conflict', error.code)
      : denied()
  if (error instanceof CustomRoleWriteError) {
    if (error.code === 'custom_roles_disabled') throw disabled()
    if (error.code === 'invalid_request') throw new DomainError('invalid', error.code)
    throw new DomainError('conflict', error.code)
  }
  throw error
}

function session(principal: Principal) {
  if (principal.kind !== 'session') throw denied()
  return principal
}

const elevated: TeamPermissionCheck['fixed'] = ({ role }) =>
  teamRoles(role).some((token) => token === 'owner' || token === 'admin') ? 'elevated' : 'denied'

// This summary uses team-wide predicates. Actions which need a target or depend on a separate
// feature gate stay with their operation until that operation's authorization is wired here.
const fixedSummaryChecks: readonly TeamPermissionCheck[] = [
  { operation: 'members.read', fixed: () => 'base' },
  {
    operation: 'members.read_private',
    fixed: ({ role }) => (canReadPrivateTeamRoster(role) ? 'elevated' : 'denied'),
  },
  { operation: 'invitations.read', fixed: elevated },
  { operation: 'invitations.create', fixed: elevated },
  {
    operation: 'members.assign_role',
    fixed: ({ role }) => (teamRoles(role).includes('owner') ? 'elevated' : 'denied'),
  },
]

const fixedSummaryOperations = new Set(fixedSummaryChecks.map(({ operation }) => operation))
const summaryChecks: readonly TeamPermissionCheck[] = [
  ...fixedSummaryChecks,
  ...customRoleCatalogueV1.phaseOne.map(
    (operation): TeamPermissionCheck => ({
      operation,
      fixed: () => 'denied',
      custom: true,
    }),
  ),
]

export function customRoleRoutes(deps: FreshProofDeps & { enabled?: boolean }): RouteModule {
  const enabled = deps.enabled === true
  const hardOff = createMiddleware<CallerEnv>(async (_c, next) => {
    if (!enabled) throw disabled()
    await next()
  })
  const sameOrigin = createMiddleware<CallerEnv>(async (c, next) => {
    if (c.req.header('origin') !== new URL(deps.publicUrl).origin) throw denied()
    await next()
  })
  return ({ app, caller }) => {
    const sessionCaller = teamManagementSessionCaller(caller)
    const common = { tags: ['Team roles'], security: [{ session: [] }] }
    const middleware: [typeof hardOff, typeof sessionCaller] = [hardOff, sessionCaller]
    const writeMiddleware: [typeof hardOff, typeof sameOrigin, typeof sessionCaller] = [
      hardOff,
      sameOrigin,
      sessionCaller,
    ]
    const expected = (c: Context, fallback = '') =>
      c.req.header(EXPECTED_ORGANIZATION_HEADER) ?? fallback
    const write = async (
      c: Context<CallerEnv>,
      teamId: string,
      command: CustomRoleCommand,
      schema: z.ZodObject,
      input: Record<string, unknown>,
    ) => {
      const principal = session(c.var.principal)
      const expectedOrganizationId = expected(c)
      // Validate a stale or mismatched context before the proof transaction takes its team lock.
      await checkTeamManagementAccess(deps.db, principal, teamId, false, {
        expectedOrganizationId,
        allowPersonal: false,
      }).catch(translate)
      const target =
        command.kind === 'assign' ? command.memberId : 'roleId' in command ? command.roleId : null
      const callbacks = customRoleWrite({
        enabled,
        principal,
        teamId,
        expectedOrganizationId,
        command,
      })
      const result = await runWithFreshProof(
        deps,
        {
          headers: c.req.raw.headers,
          userId: principal.user.id,
          sessionId: principal.sessionId,
          organizationId: teamId,
          operation: `customRoles_${command.kind}`,
          proofMode: 'administration',
          input: { ...input, target },
          schema: schema.extend({ target: z.uuid().nullable() }),
        },
        { ...callbacks, beforeLocks: organizationContextWriteLock(principal) },
      ).catch(translate)
      if (result.setCookie) c.header('Set-Cookie', result.setCookie, { append: true })
      return result
    }

    app.openapi(
      createRoute({
        ...common,
        method: 'get',
        path: `${teamPath}/permissions`,
        operationId: 'getTeamPermissions',
        summary: 'Read the current browser session’s team-wide permission decisions',
        middleware,
        request: { params: teamParams, headers },
        responses: {
          ...errors,
          200: {
            description:
              'Decisions for supported fixed checks and current custom grants. Target and field checks are performed by each operation.',
            content: json(permissionView),
          },
        },
      }),
      async (c) => {
        const principal = session(c.var.principal)
        const { teamId } = c.req.valid('param')
        const result = await deps.db
          .transaction()
          .execute(async (trx) => {
            await checkTeamManagementAccess(
              trx,
              principal,
              teamId,
              'share',
              {
                expectedOrganizationId: expected(c, teamId),
                allowPersonal: false,
              },
              true,
            )
            await lockTeamSsoProof(
              deps,
              trx,
              { sessionId: principal.sessionId, userId: principal.user.id },
              teamId,
              () => {
                throw new DomainError('forbidden', 'sso_required')
              },
              { organizationLocked: true },
            )
            const issued = await trx
              .selectFrom('team_credential_authorizations')
              .select(['id', 'credential_generation'])
              .where('organization_id', '=', teamId)
              .where('user_id', '=', principal.user.id)
              .where('session_id', '=', principal.sessionId)
              .executeTakeFirst()
            return resolveTeamPermissions(trx, principal, teamId, summaryChecks, {
              available: enabled,
              ...(issued && {
                credential: {
                  authorizationId: issued.id,
                  generation: issued.credential_generation,
                },
              }),
            })
          })
          .catch(translate)
        if (!result) throw denied()
        return c.json(
          {
            ...result,
            decisions: result.decisions.filter(
              ({ operation, source }) =>
                source === 'custom' || fixedSummaryOperations.has(operation),
            ),
          },
          200,
        )
      },
    )
    app.openapi(
      createRoute({
        ...common,
        method: 'get',
        path: `${teamPath}/roles`,
        operationId: 'listCustomTeamRoles',
        summary: 'List the team’s active custom roles',
        middleware,
        request: {
          params: teamParams,
          headers,
          query: z.object({
            after: z.uuid().optional(),
            limit: z.coerce.number().int().min(1).max(100).optional(),
          }),
        },
        responses: {
          ...errors,
          200: { description: 'A page ordered by role ID', content: json(z.array(roleView)) },
        },
      }),
      async (c) => {
        const principal = session(c.var.principal)
        const { teamId } = c.req.valid('param')
        const { after, limit } = c.req.valid('query')
        return c.json(
          await readCustomRoles(deps.db, {
            enabled,
            principal,
            teamId,
            expectedOrganizationId: expected(c, teamId),
            ssoCapabilities: deps.capabilities,
            ...(after !== undefined && { after }),
            ...(limit !== undefined && { limit }),
          }).catch(translate),
          200,
        )
      },
    )
    app.openapi(
      createRoute({
        ...common,
        method: 'get',
        path: `${teamPath}/roles/{roleId}`,
        operationId: 'getCustomTeamRole',
        summary: 'Read a custom role and its published revision',
        middleware,
        request: { params: roleParams, headers },
        responses: {
          ...errors,
          200: { description: 'The requested role', content: json(roleView) },
        },
      }),
      async (c) => {
        const principal = session(c.var.principal)
        const { teamId, roleId } = c.req.valid('param')
        const [role] = await readCustomRoles(deps.db, {
          enabled,
          principal,
          teamId,
          expectedOrganizationId: expected(c, teamId),
          ssoCapabilities: deps.capabilities,
          roleId,
        }).catch(translate)
        if (!role) throw denied()
        return c.json(role, 200)
      },
    )
    app.openapi(
      createRoute({
        ...common,
        method: 'post',
        path: `${teamPath}/roles`,
        operationId: 'createCustomTeamRole',
        summary: 'Create a custom role and publish its first revision',
        middleware: writeMiddleware,
        request: {
          params: teamParams,
          headers,
          body: { required: true, content: json(definition.extend(proofAttempt)) },
        },
        responses: {
          ...writeErrors,
          200: { description: 'The created role', content: json(mutationResult) },
        },
      }),
      async (c) => {
        const { teamId } = c.req.valid('param')
        const input = c.req.valid('json')
        const { name, permissionIds } = input
        const result = await write(
          c,
          teamId,
          { kind: 'create', name, permissionIds },
          definition,
          input,
        )
        return result.status === 'proof_required'
          ? c.json(result.body, 403)
          : c.json(result.value, 200)
      },
    )
    app.openapi(
      createRoute({
        ...common,
        method: 'patch',
        path: `${teamPath}/roles/{roleId}`,
        operationId: 'publishCustomTeamRole',
        summary: 'Publish a new immutable revision of a custom role',
        middleware: writeMiddleware,
        request: {
          params: roleParams,
          headers,
          body: { required: true, content: json(publication.extend(proofAttempt)) },
        },
        responses: {
          ...writeErrors,
          200: { description: 'The published role', content: json(mutationResult) },
        },
      }),
      async (c) => {
        const { teamId, roleId } = c.req.valid('param')
        const input = c.req.valid('json')
        const { expectedRevision, name, permissionIds } = input
        const result = await write(
          c,
          teamId,
          {
            kind: 'publish',
            roleId,
            expectedRevision,
            name,
            permissionIds,
          },
          publication,
          input,
        )
        return result.status === 'proof_required'
          ? c.json(result.body, 403)
          : c.json(result.value, 200)
      },
    )
    app.openapi(
      createRoute({
        ...common,
        method: 'delete',
        path: `${teamPath}/roles/{roleId}`,
        operationId: 'archiveCustomTeamRole',
        summary: 'Archive a custom role with no current assignments',
        middleware: writeMiddleware,
        request: {
          params: roleParams,
          headers,
          body: { required: true, content: json(archive.extend(proofAttempt)) },
        },
        responses: {
          ...writeErrors,
          200: { description: 'The archived role', content: json(mutationResult) },
        },
      }),
      async (c) => {
        const { teamId, roleId } = c.req.valid('param')
        const input = c.req.valid('json')
        const result = await write(
          c,
          teamId,
          {
            kind: 'archive',
            roleId,
            expectedRevision: input.expectedRevision,
          },
          archive,
          input,
        )
        return result.status === 'proof_required'
          ? c.json(result.body, 403)
          : c.json(result.value, 200)
      },
    )
    app.openapi(
      createRoute({
        ...common,
        method: 'put',
        path: `${teamPath}/members/{memberId}/custom-role`,
        operationId: 'assignCustomTeamRole',
        summary: 'Set or clear a current member’s custom role',
        middleware: writeMiddleware,
        request: {
          params: memberParams,
          headers,
          body: { required: true, content: json(assignment.extend(proofAttempt)) },
        },
        responses: {
          ...writeErrors,
          200: { description: 'The current assignment', content: json(mutationResult) },
        },
      }),
      async (c) => {
        const { teamId, memberId } = c.req.valid('param')
        const input = c.req.valid('json')
        const { expectedGeneration, roleId, expectedRevision } = input
        const result = await write(
          c,
          teamId,
          {
            kind: 'assign',
            memberId,
            expectedGeneration,
            roleId,
            expectedRevision,
          },
          assignment,
          input,
        )
        return result.status === 'proof_required'
          ? c.json(result.body, 403)
          : c.json(result.value, 200)
      },
    )
  }
}
