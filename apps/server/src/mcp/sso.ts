import { z } from '@hono/zod-openapi'
import { SsoPolicy, SsoProviderPage } from '../routes/sso.ts'
import { requireSsoRetained } from '../sso.ts'
import { getSsoPolicy, listSsoProviders, type SsoReadDeps } from '../sso-reads.ts'
import { defineTool, type Tool } from './tools.ts'

const GET_SSO_POLICY = 'get_sso_policy'

/** Administrator reads use the same authorization and safe projections as REST. */
export function ssoReadTools(deps: SsoReadDeps): Tool[] {
  const shared = {
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    requireEnabled: () => requireSsoRetained(deps.capabilities),
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
        'Lists safe provider summaries for the current team, for owners/admins with read/full API key scope or mcp:tools OAuth. Pass nextCursor as cursor for the next page. Never returns configuration, secrets, raw metadata or identities. OIDC SSO is off unless the operator sets SSO_OIDC_ENABLED=true; while off, this read still answers for stored configuration.',
      input: z.strictObject({
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      output: SsoProviderPage,
      run: (args, call) => listSsoProviders(deps, call.caller, args),
    }),
    defineTool({
      ...shared,
      name: GET_SSO_POLICY,
      title: 'Get SSO policy',
      description:
        'Reads the current team SSO policy for owners/admins with read/full API key scope or mcp:tools OAuth. Never returns configuration, secrets, raw metadata or identities. OIDC SSO is off unless the operator sets SSO_OIDC_ENABLED=true; while off, this read still answers for stored configuration.',
      input: z.strictObject({}),
      output: SsoPolicy,
      run: (_args, call) => getSsoPolicy(deps, call.caller, call.teamRead?.policy),
    }),
  ]
}
