import { z } from '@hono/zod-openapi'
import { describeCaller, Me } from '../me.ts'
import { defineTool } from './tools.ts'

/** The same data as GET /api/v1/me. */
export const whoamiTool = defineTool({
  name: 'whoami',
  title: 'Who am I',
  description:
    'Returns who this connection acts as: the user who owns the API key, the organization the key acts in, and the key id (principal.kind is always api_key here). Use it to check that the connection works, or to learn whose bookings list_bookings and cancel_booking (by bookingId) operate on. Takes no arguments.',
  input: z.strictObject({}),
  output: Me,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  run: async (_args, { caller }) => describeCaller(caller),
})
