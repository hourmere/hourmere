import { z } from 'zod'
import {
  conferenceTokenAad,
  decryptConferenceCredential,
  encryptConferenceCredential,
} from './credentials.ts'
import { ZoomError, type ZoomMode, type ZoomTokens } from './zoom.ts'

const stored = z.strictObject({
  accessToken: z.string().min(1).max(8192),
  refreshToken: z.string().min(1).max(8192),
  expiresAt: z.number().finite().positive(),
})
export function credentials(
  key: Buffer,
  owner: string,
  id: string,
  external: string,
  tokens: ZoomTokens,
  mode: ZoomMode,
) {
  return encryptConferenceCredential(
    key,
    conferenceTokenAad(owner, id, external, mode),
    JSON.stringify({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    }),
  )
}
export function readTokens(
  key: Buffer,
  owner: string,
  id: string,
  external: string,
  value: Buffer,
  mode: ZoomMode,
) {
  try {
    if (value.length > 32768) throw new Error()
    return stored.parse(
      JSON.parse(
        decryptConferenceCredential(key, conferenceTokenAad(owner, id, external, mode), value),
      ),
    )
  } catch {
    throw new ZoomError('needs_reauth')
  }
}
