// The page an emailed sign-in link opens. Mail scanners (e.g. Microsoft Safe Links) open
// every link in an email, which would use up a one-time link that signs in on opening; this
// page signs in only when the person presses its button. It is self-contained (no web app,
// no external files), so it works wherever the server runs.
import { createHash } from 'node:crypto'
import { MAGIC_LINK_CONFIRM_PATH, MAGIC_LINK_VERIFY_PARAMS } from '@hourmere/auth'
import type { Context } from 'hono'

export { MAGIC_LINK_CONFIRM_PATH }

// The link carries Better Auth's verify parameters in its fragment (see confirmLink), which
// the browser never sends to the server. This copies them into the form; pressing the button
// then submits Better Auth's verify request. Nothing submits on its own.
const SCRIPT = `
const params = new URLSearchParams(location.hash.slice(1));
const form = document.getElementById('confirm');
if (params.get('token')) {
  for (const name of ${JSON.stringify(MAGIC_LINK_VERIFY_PARAMS)}) {
    const value = params.get(name);
    if (value === null) continue;
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.append(input);
  }
  form.hidden = false;
} else {
  document.getElementById('incomplete').hidden = false;
}
`

const STYLE = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.5; }
body { margin: 0; padding: 48px 16px; }
main { max-width: 420px; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 16px; }
button { font: inherit; font-weight: 600; padding: 10px 20px; border: 0; border-radius: 6px;
  background: CanvasText; color: Canvas; cursor: pointer; }
.note { color: GrayText; font-size: 0.875rem; }
[hidden] { display: none !important; }
`

const hash = (source: string) => `'sha256-${createHash('sha256').update(source).digest('base64')}'`

// Only this page's own script and style run, and its form can only submit to this origin.
const CSP = [
  "default-src 'none'",
  `script-src ${hash(SCRIPT)}`,
  `style-src ${hash(STYLE)}`,
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in to Hourmere</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Sign in to Hourmere</h1>
<form id="confirm" method="get" action="/api/auth/magic-link/verify" hidden>
<p>Press the button to finish signing in.</p>
<p><button type="submit">Sign in to Hourmere</button></p>
<p class="note">This extra step keeps email security scanners, which open links to check them, from using up your sign-in link.</p>
</form>
<p id="incomplete" hidden>This sign-in link is incomplete. Open the whole link from the email, or ask for a new one.</p>
<noscript><p>Signing in needs JavaScript. Turn it on for this page, then open the link from the email again.</p></noscript>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`

/** GET handler for MAGIC_LINK_CONFIRM_PATH. */
export function signInConfirmPage(c: Context) {
  return c.html(PAGE, 200, {
    'Content-Security-Policy': CSP,
    // The button's request (and the redirects after it) get no Referer from this page.
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
}
