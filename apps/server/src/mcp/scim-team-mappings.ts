import { z } from '@hono/zod-openapi'
import {
  CommitScimTeamMapping,
  ScimTeamMappingResult,
  scimTeamMappingRoutes,
} from '../routes/scim-team-mappings.ts'
import { commitScimTeamMapping, type ScimTeamHierarchyDeps } from '../scim-team-hierarchy.ts'
import { defineTool, type Tool } from './tools.ts'

export function scimMappingAdministration(deps: ScimTeamHierarchyDeps) {
  return { route: scimTeamMappingRoutes(deps), tools: scimTeamMappingTools(deps) }
}

function scimTeamMappingTools(deps: ScimTeamHierarchyDeps): Tool[] {
  if (!deps.resourcesEnabled) return []
  const shared = {
    output: ScimTeamMappingResult,
    privateInput: () => true,
    privateValidationMessage: 'Invalid SCIM mapping request',
    privateDiagnostics: true,
  }
  const annotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  }
  return [
    defineTool({
      ...shared,
      name: 'create_scim_team_mapping',
      title: 'Finalize a SCIM team link',
      description:
        'Finalizes the link named by intentId after both team owners independently approve in their browsers. You must be one of those owners. Requires a full API key or mcp:tools OAuth and a live delegation for your team if it enforces SSO.',
      input: CommitScimTeamMapping,
      annotations,
      run: (args, { caller }) =>
        commitScimTeamMapping(deps, caller, args.intentId, { action: 'link' }),
    }),
    defineTool({
      ...shared,
      name: 'delete_scim_team_mapping',
      title: 'Finalize a SCIM team unlink',
      description:
        'Finalizes the unlink named by intentId and its exact mapping id after both team owners independently approve in their browsers. You must be one of those owners. Requires a full API key or mcp:tools OAuth and a live delegation for your team if it enforces SSO.',
      input: CommitScimTeamMapping.extend({ id: z.string().openapi({ format: 'uuid' }) }),
      annotations: { ...annotations, destructiveHint: true },
      run: (args, { caller }) =>
        commitScimTeamMapping(deps, caller, args.intentId, {
          action: 'unlink',
          mappingId: args.id,
        }),
    }),
  ]
}
