import { APIError } from 'better-auth/api'
import type { AuthMiddlewareContext } from './api-keys.ts'

export const DISPLAY_NAME_MAX_LENGTH = 200

/** Names are used in email subjects and calendar organizer labels as well as the UI. */
export function displayNameRules(ctx: AuthMiddlewareContext) {
  if (ctx.path !== '/update-user') return
  const body: unknown = ctx.body
  if (typeof body !== 'object' || body === null || !Object.hasOwn(body, 'name')) return
  const value = (body as Record<string, unknown>).name
  const name = typeof value === 'string' ? value.trim() : ''
  if (
    !name ||
    name.length > DISPLAY_NAME_MAX_LENGTH ||
    !name.isWellFormed() ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(name)
  ) {
    throw new APIError('BAD_REQUEST', {
      code: 'INVALID_DISPLAY_NAME',
      message: `Name must be a single line of text between 1 and ${DISPLAY_NAME_MAX_LENGTH} characters.`,
    })
  }
  return { context: { body: { ...body, name } } }
}
