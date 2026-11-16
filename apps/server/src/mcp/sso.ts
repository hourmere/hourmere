import { z } from '@hono/zod-openapi'
import { SsoPolicy, SsoProviderPage } from '../routes/sso.ts'
import { requireSsoEnabled } from '../sso.ts'
import { getSsoPolicy, listSsoProviders, type SsoReadDeps } from '../sso-reads.ts'
import { defineTool, type Tool } from './tools.ts'

/** Administrator reads use the same authorization and safe projections as REST. */
export function ssoReadTools(deps: SsoReadDeps): Tool[] {
  const shared = {
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    requireEnabled: () => requireSsoEnabled(deps.capabilities),
    privateInput: () => true,
    privateValidationMessage: 'Invalid SSO read request',
    privateDiagnostics: true,
  }
  return [
    defineTool({
      ...shared,
      name: 'list_sso_providers',
      title: 'List SSO providers',
      description:
        'Lists safe provider summaries for the current team, for owners/admins with read/full API key scope or mcp:tools OAuth. Pass nextCursor as cursor for the next page. Never returns configuration, secrets, raw metadata or identities. SSO is being built and is not available yet.',
      input: z.strictObject({
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      output: SsoProviderPage,
      run: (args, call) => listSsoProviders(deps, call.caller, args),
    }),
    defineTool({
      ...shared,
      name: 'get_sso_policy',
      title: 'Get SSO policy',
      description:
        'Reads the current team SSO policy for owners/admins with read/full API key scope or mcp:tools OAuth. Never returns configuration, secrets, raw metadata or identities. SSO is being built and is not available yet.',
      input: z.strictObject({}),
      output: SsoPolicy,
      run: (_args, call) => getSsoPolicy(deps, call.caller),
    }),
  ]
}
