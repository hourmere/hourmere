import { signJWT } from 'better-auth/plugins/jwt'
import type { Auth } from './index.ts'

/** Signs synthetic claims using a throwaway auth instance's real access-token signing key. */
export async function signTestMcpAccessToken(auth: Auth, claims: Record<string, unknown>) {
  return signJWT({ context: await auth.$context } as Parameters<typeof signJWT>[0], {
    header: { typ: 'at+jwt' },
    payload: claims,
  })
}
