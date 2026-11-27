import type { Db } from '@hourmere/db'
import { getPublicTeam } from '@hourmere/scheduling'
import { PublicTeam, PublicTeamParams } from '../routes/public.ts'
import { defineTool } from './tools.ts'

export function publicTeamTool({
  db,
  teamPublicHomeOrganizationIds,
  scimResourcesEnabled,
}: {
  db: Db
  teamPublicHomeOrganizationIds?: readonly string[] | undefined
  scimResourcesEnabled?: boolean | undefined
}) {
  return defineTool({
    name: 'get_public_team',
    title: 'Read a public team directory',
    description:
      'Give the exact-case team slug as handle. Returns the team name, slug and listed booking event types. An enabled team with nothing to list has an empty eventTypes array. An unknown or disabled directory returns team_not_found. Accepts read, bookings or full keys, or an authorized MCP OAuth connection.',
    input: PublicTeamParams.strict(),
    output: PublicTeam,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: (args) =>
      getPublicTeam(
        {
          db,
          now: () => Temporal.Now.instant(),
          teamPublicHomeOrganizationIds,
          scimResourcesEnabled,
        },
        args,
      ),
  })
}
