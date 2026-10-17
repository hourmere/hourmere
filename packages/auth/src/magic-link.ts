import type { AuthMiddlewareContext } from './api-keys.ts'

/**
 * Where an emailed sign-in link leads: a page with a button that submits Better Auth's verify
 * request. Mail scanners (e.g. Microsoft Safe Links) open every link in an email; opening this
 * page does not use up the one-time token, only pressing the button does.
 */
export const MAGIC_LINK_CONFIRM_PATH = '/sign-in/confirm'

/** The parameters of Better Auth's verify endpoint, which the confirm page passes on. */
export const MAGIC_LINK_VERIFY_PARAMS = [
  'token',
  'callbackURL',
  'newUserCallbackURL',
  'errorCallbackURL',
] as const

/**
 * Turns Better Auth's verify URL into the link to email: the confirm page, with the verify
 * parameters (token, callbackURL, …) in the fragment. Browsers never send the fragment, so
 * opening the link puts the token in no request log (ours or a proxy's) and no Referer
 * header. The button's request does carry it in the query string: our request log drops
 * query strings, but a reverse proxy may log it. Better Auth usually uses the token up in
 * that request, but some refusals come first (a rate limit's 429, an invalid callback URL's
 * 403), so a logged token can still be valid until it expires.
 */
export function confirmLink(verifyUrl: string): string {
  const url = new URL(verifyUrl)
  return `${url.origin}${MAGIC_LINK_CONFIRM_PATH}#${url.search.slice(1)}`
}

/** The app explains sign-in error codes here and lets the person request another link. */
export const SIGN_IN_PATH = '/sign-in'

/** Better Auth otherwise sends a failed magic link to its success callback URL. */
export function defaultMagicLinkErrorRedirect(ctx: AuthMiddlewareContext) {
  if (ctx.path !== '/magic-link/verify') return
  const errorCallback = ctx.query?.errorCallbackURL
  // Explicit callbacks remain Better Auth's to validate. Empty has the same meaning as absent.
  if (errorCallback !== undefined && errorCallback !== '') return
  return { context: { query: { ...ctx.query, errorCallbackURL: SIGN_IN_PATH } } }
}
