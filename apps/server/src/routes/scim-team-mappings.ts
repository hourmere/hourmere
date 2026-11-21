import { createRoute, z } from '@hono/zod-openapi'
import { createMiddleware } from 'hono/factory'
import type { CallerEnv } from '../caller.ts'
import { authenticated, errorResponses, json, type RouteModule } from '../openapi.ts'
import {
  approveScimTeamMapping,
  commitScimTeamMapping,
  listScimTeamMappings,
  type ScimTeamHierarchyDeps,
  ScimTeamMappingApproval,
} from '../scim-team-hierarchy.ts'
import { mappingDenied, mappingUuid } from '../scim-team-hierarchy-proof.ts'
import { EXPECTED_ORGANIZATION_HEADER } from '../team-management.ts'
import { FreshProofChallenge } from './sso-drafts.ts'

export const SCIM_TEAM_MAPPINGS_PATH = '/api/v1/scim/team-mappings'
export const CommitScimTeamMapping = z.strictObject({ intentId: z.uuid() })
export const ScimTeamMappingResult = z
  .object({ mappingId: z.uuid(), generation: z.int().nonnegative() })
  .openapi('ScimTeamMappingResult')
const Mapping = z
  .object({
    id: z.uuid(),
    parentOrganizationId: z.uuid(),
    childOrganizationId: z.uuid(),
    connectionId: z.uuid(),
    externalId: z.string(),
    state: z.enum(['pending', 'suspended']),
  })
  .openapi('ScimTeamMapping')
const MappingList = z
  .object({
    mappings: z.array(Mapping),
    connectionId: z.uuid().nullable(),
    linkGeneration: z.int().nonnegative().nullable(),
  })
  .openapi('ScimTeamMappingList')

const expectedTeam = z.object({
  'x-expected-organization-id': z
    .string()
    .optional()
    .openapi({ description: 'Required for browser writes and must match the active team.' }),
})
const privateHeaders = createMiddleware<CallerEnv>(async (c, next) => {
  c.header('Cache-Control', 'private, no-store')
  c.header('Referrer-Policy', 'no-referrer')
  await next()
})
const consentSession = createMiddleware<CallerEnv>(async (c, next) => {
  if (c.req.raw.headers.has('authorization')) throw mappingDenied()
  await next()
})
const finalizeTeam = createMiddleware<CallerEnv>(async (c, next) => {
  const principal = c.var.principal
  if (principal.kind === 'session') {
    const expected = mappingUuid.safeParse(c.req.header(EXPECTED_ORGANIZATION_HEADER))
    if (!expected.success || expected.data !== principal.organization.id.toLowerCase())
      throw mappingDenied()
  }
  await next()
})

export function scimTeamMappingRoutes(deps: ScimTeamHierarchyDeps): RouteModule {
  return ({ app, caller, scimResourcesEnabled }) => {
    if (!scimResourcesEnabled) return
    const common = { tags: ['SCIM team mappings'], security: authenticated }
    const errors = errorResponses({
      400: 'invalid_request',
      403: 'scim_mapping_access_denied or scim_mapping_privileged_member',
      409: 'scim_mapping_topology_conflict, scim_mapping_generation_changed or guarded departure',
    })
    app.openapi(
      createRoute({
        ...common,
        method: 'get',
        path: SCIM_TEAM_MAPPINGS_PATH,
        operationId: 'listScimTeamMappings',
        summary: 'List live mappings involving the current team',
        description:
          'Requires a current owner or administrator of the active team. Link preparation metadata describes the active team and is only returned to owners.',
        middleware: [privateHeaders, caller] as const,
        request: { headers: expectedTeam },
        responses: {
          200: { description: 'Safe mapping metadata', content: json(MappingList) },
          ...errorResponses({ 403: 'scim_mapping_access_denied' }),
        },
      }),
      async (c) =>
        c.json(
          await listScimTeamMappings(
            deps,
            c.var.principal,
            c.req.header(EXPECTED_ORGANIZATION_HEADER),
          ),
          200,
        ),
    )
    app.openapi(
      createRoute({
        ...common,
        method: 'post',
        path: SCIM_TEAM_MAPPINGS_PATH,
        operationId: 'createScimTeamMapping',
        summary: 'Finalize a link approved by the owners on both sides',
        description: 'Supply the approved link intent ID. Both approvals must still be live.',
        middleware: [privateHeaders, caller, finalizeTeam] as const,
        request: {
          headers: expectedTeam,
          body: { required: true, content: json(CommitScimTeamMapping) },
        },
        responses: {
          201: { description: 'The linked mapping', content: json(ScimTeamMappingResult) },
          ...errors,
        },
      }),
      async (c) =>
        c.json(
          await commitScimTeamMapping(deps, c.var.principal, c.req.valid('json').intentId, {
            action: 'link',
          }),
          201,
        ),
    )
    app.openapi(
      createRoute({
        ...common,
        method: 'delete',
        path: '/api/v1/scim/team-mappings/{id}',
        operationId: 'deleteScimTeamMapping',
        summary: 'Finalize an unlink approved by the owners on both sides',
        description: 'Supply the approved unlink intent ID and the exact mapping ID.',
        middleware: [privateHeaders, caller, finalizeTeam] as const,
        request: {
          headers: expectedTeam,
          params: z.object({ id: z.string().openapi({ format: 'uuid' }) }),
          body: { required: true, content: json(CommitScimTeamMapping) },
        },
        responses: {
          200: { description: 'The unlinked mapping', content: json(ScimTeamMappingResult) },
          ...errors,
        },
      }),
      async (c) =>
        c.json(
          await commitScimTeamMapping(deps, c.var.principal, c.req.valid('json').intentId, {
            action: 'unlink',
            mappingId: c.req.valid('param').id,
          }),
          200,
        ),
    )
    app.openapi(
      createRoute({
        ...common,
        method: 'post',
        path: '/api/v1/scim/team-mappings/consent',
        operationId: 'approveScimTeamMapping',
        summary: 'Approve a mapping intent for the current team',
        description:
          'Requires a current verified owner browser session, the current team header and fresh administration proof. Each team approves the same intent independently.',
        security: [{ session: [] }],
        middleware: [privateHeaders, consentSession, caller] as const,
        request: {
          headers: expectedTeam,
          body: { required: true, content: json(ScimTeamMappingApproval) },
        },
        responses: {
          ...errors,
          200: { description: 'Consent recorded', content: json(CommitScimTeamMapping) },
          403: {
            description: 'scim_mapping_access_denied or sso_reauthentication_required',
            content: json(FreshProofChallenge),
          },
        },
      }),
      async (c) => {
        const result = await approveScimTeamMapping(
          deps,
          c.var.principal,
          c.req.raw.headers,
          c.req.valid('json'),
        )
        if (result.setCookie) c.header('Set-Cookie', result.setCookie, { append: true })
        if (result.status === 'proof_required') return c.json(result.body, 403)
        return c.json(result.value, 200)
      },
    )
  }
}
