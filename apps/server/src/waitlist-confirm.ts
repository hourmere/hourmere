// Emailed waitlist capabilities stay in the fragment and then in this page's memory.
// GET/HEAD only render; an explicit button press sends a same-origin JSON POST.
import { createHash } from 'node:crypto'
import {
  acceptLanguage,
  cookieLanguage,
  interfaceLanguages,
  registeredLocales,
} from '@hourmere/core/language'
import { DomainError } from '@hourmere/scheduling/errors'
import type { Context, Env, Hono } from 'hono'
import { clientIp } from './client-ip.ts'
import { waitlistConfirmationCatalogues } from './i18n/waitlist-confirmation.ts'
import { createRateLimiter, PUBLIC_RATE_LIMITS, rateLimit } from './rate-limit.ts'

// Use an existing reserved namespace so legacy handles and event slugs stay routable.
export const WAITLIST_VERIFY_PATH = '/booking/waitlist/verify'
export const WAITLIST_REMOVE_PATH = '/booking/waitlist/remove'
const TOKEN = /^[a-f\d-]{36}\.[A-Za-z0-9_-]{43}$/
const MAX_BODY_BYTES = 1024
const publicLocales = registeredLocales.filter(({ code }) =>
  interfaceLanguages('public').includes(code),
)

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const CATALOGUES_JSON = JSON.stringify(waitlistConfirmationCatalogues).replaceAll('<', '\\u003c')

const SCRIPT = `
(() => {
  const mode = document.body.dataset.mode;
  const fragment = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  const params = new URLSearchParams(fragment);
  let token = mode === 'verify' && params.has('token') ? params.get('token') : fragment;
  let management = mode === 'verify' ? params.get('management') : null;
  const valid = ${TOKEN.toString()};
  if (!valid.test(token || '')) token = null;
  if (!valid.test(management || '')) management = null;
  const catalogues = ${CATALOGUES_JSON};
  const language = document.getElementById('language');
  const action = document.getElementById('action');
  const remove = document.getElementById('remove');
  const status = document.getElementById('status');
  let state = token ? 'ready' : 'incomplete';
  let busy = false;
  function render() {
    const words = catalogues[language.value];
    document.documentElement.lang = language.value;
    document.title = mode === 'verify' ? words.verifyTitle : words.removeTitle;
    document.getElementById('title').textContent = document.title;
    document.getElementById('instruction').textContent = mode === 'verify' ? words.verifyInstruction : words.removeInstruction;
    document.getElementById('scanner-note').textContent = words.scannerNote;
    document.getElementById('language-label').textContent = words.language;
    action.textContent = mode === 'verify' ? words.verifyAction : words.removeAction;
    remove.textContent = words.removeAction;
    action.hidden = !token || state === 'verified' || state === 'removed' || state === 'invalid';
    action.disabled = busy;
    remove.hidden = mode !== 'verify' || !management || state === 'removed';
    remove.disabled = busy;
    status.textContent = state === 'ready' ? '' : words[state];
  }
  async function submit(removing) {
    if (busy) return;
    const capability = removing ? management : token;
    if (!capability) return;
    busy = true;
    render();
    try {
      const response = await fetch(removing ? '${WAITLIST_REMOVE_PATH}' : '${WAITLIST_VERIFY_PATH}', {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: capability }),
      });
      state = response.ok ? (removing ? 'removed' : 'verified') : response.status === 429 ? 'retry' : response.status === 404 ? 'invalid' : 'unavailable';
      if (response.ok) {
        token = null;
        if (removing) management = null;
      }
    } catch {
      state = 'unavailable';
    }
    busy = false;
    render();
  }
  action.addEventListener('click', () => {
    if (mode === 'remove') {
      management = token;
      void submit(true);
    } else void submit(false);
  });
  remove.addEventListener('click', () => { void submit(true); });
  language.addEventListener('change', render);
  render();
})();
`

const STYLE = `
:root { color-scheme: light dark; font: 1rem/1.55 system-ui, sans-serif; color: #0e1015; background: #f7f9fe; }
* { box-sizing: border-box; }
body { margin: 0; overflow-wrap: anywhere; }
main { width: min(100% - 2rem, 30rem); margin: 10vh auto; padding: 1.5rem; border: 1px solid #d6deef; border-radius: 10px; background: #fff; }
header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; }
h1 { font-size: 1.5rem; line-height: 1.25; margin: 1.5rem 0 1rem; }
p { margin: 0 0 1rem; }
button, select { max-width: 100%; min-height: 44px; padding: .6rem .8rem; font: inherit; border: 1px solid #7a8ab0; border-radius: 6px; color: inherit; background: transparent; }
button { width: 100%; cursor: pointer; margin: .5rem 0; }
#action { color: #fff; background: #1f4fd8; border-color: #1f4fd8; }
button:disabled { cursor: wait; opacity: .7; }
:focus-visible { outline: 3px solid #1f4fd8; outline-offset: 2px; }
.note { font-size: .875rem; color: #475066; }
.language { display: grid; gap: .25rem; font-size: .875rem; }
[hidden] { display: none !important; }
@media (prefers-color-scheme: dark) {
  :root { color: #e9edf7; background: #0e1015; }
  main { background: #151c2e; border-color: #283252; }
  .note { color: #a9b3c9; }
  select { background: #151c2e; }
  :focus-visible { outline-color: #8faeff; }
}
`
const hash = (source: string) => `'sha256-${createHash('sha256').update(source).digest('base64')}'`
const CSP = [
  "default-src 'none'",
  `script-src ${hash(SCRIPT)}`,
  `style-src ${hash(STYLE)}`,
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

function confirmationPage(c: Context, mode: 'verify' | 'remove') {
  const preference = cookieLanguage(c.req.header('Cookie'))
  const language =
    preference && interfaceLanguages('public').includes(preference)
      ? preference
      : acceptLanguage(c.req.header('Accept-Language'), 'public')
  const words = waitlistConfirmationCatalogues[language]
  const title = mode === 'verify' ? words.verifyTitle : words.removeTitle
  const instruction = mode === 'verify' ? words.verifyInstruction : words.removeInstruction
  return c.html(`<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body data-mode="${mode}">
<main>
<header><strong>Hourmere</strong><label class="language"><span id="language-label">${escapeHtml(words.language)}</span><select id="language">${publicLocales.map(({ code, nativeName }) => `<option lang="${code}" value="${code}"${code === language ? ' selected' : ''}>${escapeHtml(nativeName)}</option>`).join('')}</select></label></header>
<h1 id="title">${escapeHtml(title)}</h1>
<p id="instruction">${escapeHtml(instruction)}</p>
<p id="status" role="status" aria-live="polite"></p>
<button id="action" type="button" hidden>${escapeHtml(mode === 'verify' ? words.verifyAction : words.removeAction)}</button>
<button id="remove" type="button" hidden>${escapeHtml(words.removeAction)}</button>
<p class="note" id="scanner-note">${escapeHtml(words.scannerNote)}</p>
<noscript><p>${escapeHtml(words.javascript)}</p></noscript>
</main>
<script>${SCRIPT}</script>
</body>
</html>`)
}

export interface WaitlistConfirmationDeps {
  publicUrl: string
  trustedProxies?: readonly string[] | undefined
  verify: (token: string) => Promise<unknown>
  remove: (token: string) => Promise<unknown>
}

/** These mail-link transports deliberately sit outside the versioned product API. */
export function registerWaitlistConfirmation<E extends Env>(
  app: Hono<E>,
  deps: WaitlistConfirmationDeps,
): void {
  const origin = new URL(deps.publicUrl).origin
  const limiter = rateLimit(createRateLimiter(PUBLIC_RATE_LIMITS.manage))
  for (const [path, mode] of [
    [WAITLIST_VERIFY_PATH, 'verify'],
    [WAITLIST_REMOVE_PATH, 'remove'],
  ] as const) {
    app.use(path, async (c, next) => {
      c.header('Cache-Control', 'no-store')
      c.header('Referrer-Policy', 'no-referrer')
      c.header('Content-Security-Policy', CSP)
      c.header('X-Content-Type-Options', 'nosniff')
      c.header('X-Frame-Options', 'DENY')
      c.header('Vary', 'Accept-Language, Cookie')
      await next()
    })
    app.use(path, clientIp(deps.trustedProxies ?? []), limiter)
    app.on(['GET', 'HEAD'], path, (c) => confirmationPage(c, mode))
    app.post(path, async (c) => {
      // Require the configured origin even for capability-bearing anonymous requests.
      // Fetch Metadata blocks same-site sibling origins as well as cross-site forms.
      const site = c.req.header('Sec-Fetch-Site')
      if (c.req.header('Origin') !== origin || (site !== undefined && site !== 'same-origin'))
        return c.json({ error: 'forbidden' }, 403)
      if (new URL(c.req.url).search) return c.json({ error: 'invalid_request' }, 400)
      if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? ''))
        return c.json({ error: 'unsupported_media_type' }, 415)
      if (Number(c.req.header('Content-Length')) > MAX_BODY_BYTES)
        return c.json({ error: 'payload_too_large' }, 413)
      let body: unknown
      try {
        const reader = c.req.raw.body?.getReader()
        if (!reader) return c.json({ error: 'invalid_request' }, 400)
        const chunks: Uint8Array[] = []
        let length = 0
        try {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            length += chunk.value.byteLength
            if (length > MAX_BODY_BYTES) {
              await reader.cancel().catch(() => {})
              return c.json({ error: 'payload_too_large' }, 413)
            }
            chunks.push(chunk.value)
          }
        } finally {
          reader.releaseLock()
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return c.json({ error: 'invalid_request' }, 400)
      }
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !('token' in body) ||
        typeof body.token !== 'string' ||
        !TOKEN.test(body.token)
      )
        return c.json({ error: 'invalid_waitlist_token' }, 404)
      try {
        await (mode === 'verify' ? deps.verify : deps.remove)(body.token)
        return c.json(mode === 'verify' ? { verified: true } : { removed: true })
      } catch (error) {
        if (error instanceof DomainError) return c.json({ error: 'invalid_waitlist_token' }, 404)
        // Never send capability-bearing service/driver errors to the request logger.
        return c.json({ error: 'internal_error' }, 500)
      }
    })
  }
}
