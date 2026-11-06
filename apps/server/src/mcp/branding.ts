import { z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import { getBranding, type ServiceContext, setBranding } from '@hourmere/scheduling'
import { BrandingUpdate, BrandingView } from '../routes/branding.ts'
import { defineTool, type McpCaller, type Tool } from './tools.ts'

/** Shares validation and authorization with REST; binary images use REST upload. */
export function brandingTools({ db }: { db: Db }): Tool[] {
  const context = (principal: McpCaller): ServiceContext => ({
    db,
    principal,
    now: () => Temporal.Now.instant(),
  })
  const read = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }
  return [
    defineTool({
      name: 'get_branding',
      title: 'Get organization branding',
      description:
        'Reads the current organization’s stored logo reference, primary color and contrast results. Requires full or read API key scope and personal owner or team owner/admin permission. Themes are not yet applied to public pages or emails.',
      input: z.strictObject({}),
      output: BrandingView,
      annotations: read,
      run(_args, call) {
        return getBranding(context(call.caller))
      },
    }),
    defineTool({
      name: 'set_branding',
      title: 'Set organization branding',
      description:
        'Sets the primary color (#RRGGBB) and/or an existing logo hash uploaded to this organization through REST or CLI. Null clears a field; omitted fields stay unchanged. Chooses readable black or white button text automatically. Requires full API key scope and personal owner or team owner/admin permission. Upload binary images with POST /api/v1/branding/logo or CLI branding upload.',
      input: BrandingUpdate,
      output: BrandingView,
      annotations: { ...read, readOnlyHint: false, destructiveHint: true },
      run(args, call) {
        return setBranding(context(call.caller), args)
      },
    }),
  ]
}
