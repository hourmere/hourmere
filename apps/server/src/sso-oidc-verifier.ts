import { jwtVerify } from 'jose'
import type { OidcJwksCache, OidcJwksProvider } from './sso-oidc-jwks.ts'
import {
  authenticationAttemptLifetime,
  oidcClockSkew,
  oidcMaximumKidBytes,
} from './sso-oidc-limits.ts'

const MAX_ID_TOKEN_BYTES = 65_536
const invalid = () => new Error('SSO ID token rejected')

/** Verifies an ID token against trusted configuration and the nonce of a consumed attempt. */
export async function verifyOidcIdToken(
  cache: Pick<OidcJwksCache, 'keyFor'>,
  provider: OidcJwksProvider & { clientId: string; trustedAdditionalAudiences?: readonly string[] },
  idToken: unknown,
  expectedNonce: string,
  now?: Date,
) {
  if (
    typeof idToken !== 'string' ||
    idToken.length === 0 ||
    idToken.length > MAX_ID_TOKEN_BYTES ||
    Buffer.byteLength(idToken) > MAX_ID_TOKEN_BYTES ||
    !/^[A-Za-z0-9_-]{43}$/.test(expectedNonce) ||
    !provider.issuer ||
    !provider.clientId
  )
    throw invalid()

  try {
    const { payload } = await jwtVerify(
      idToken,
      ({ kid }) => {
        if (typeof kid !== 'string' || !kid.trim() || Buffer.byteLength(kid) > oidcMaximumKidBytes)
          throw invalid()
        return cache.keyFor(provider, kid)
      },
      {
        algorithms: ['RS256'],
        issuer: provider.issuer,
        audience: provider.clientId,
        requiredClaims: ['sub', 'exp', 'nonce'],
        clockTolerance: oidcClockSkew,
        maxTokenAge: authenticationAttemptLifetime,
        currentDate: now,
      },
    )
    const { sub, aud, azp, iat, exp, nbf, nonce, auth_time: authTime } = payload
    // OIDC does not define a standard session deadline. When supplied, this signed
    // claim caps the browser proof independently of the ID token's callback window.
    const sessionDeadline = payload.session_expires_at
    const audiences = Array.isArray(aud) ? aud : [aud]
    if (
      audiences.some(
        (audience) =>
          typeof audience !== 'string' ||
          !audience.trim() ||
          (audience !== provider.clientId &&
            !provider.trustedAdditionalAudiences?.includes(audience)),
      ) ||
      new Set(audiences).size !== audiences.length ||
      ((audiences.length > 1 || azp !== undefined) && azp !== provider.clientId) ||
      typeof sub !== 'string' ||
      !sub.trim() ||
      !/^[\x20-\x7e]{1,255}$/.test(sub) ||
      !Number.isFinite(iat) ||
      !Number.isFinite(exp) ||
      (nbf !== undefined && !Number.isFinite(nbf)) ||
      nonce !== expectedNonce ||
      (sessionDeadline !== undefined &&
        (typeof sessionDeadline !== 'number' ||
          !Number.isFinite(sessionDeadline) ||
          sessionDeadline < 0 ||
          sessionDeadline > 253402300799)) ||
      (authTime !== undefined &&
        (typeof authTime !== 'number' ||
          !Number.isFinite(authTime) ||
          authTime > Math.floor((now?.getTime() ?? Date.now()) / 1000) + oidcClockSkew))
    )
      throw invalid()

    return {
      issuer: provider.issuer,
      subject: sub,
      authTime,
      ...(typeof payload.email === 'string' && { email: payload.email }),
      ...(typeof sessionDeadline === 'number' && {
        sessionDeadline: new Date(sessionDeadline * 1000),
      }),
    }
  } catch {
    // JOSE and the key resolver can include claims or remote data in errors. Keep no cause.
    throw invalid()
  }
}
