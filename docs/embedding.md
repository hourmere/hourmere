# Booking widgets

Embed a public personal or single-host team booking page in a website, inline or in a popup.
Widgets reuse the public booking API and do not require a visitor account or third-party
cookies. The iframe isolates the booking page's styles. Both variants retain **Powered by
Hourmere** branding.

## Enable the parent website

On the Hourmere instance, set `EMBED_ALLOWED_ORIGINS` to the exact HTTPS origins that may
embed it, then restart web processes. For example:

```dotenv
PUBLIC_URL=https://calendar.example.com
EMBED_ALLOWED_ORIGINS=https://www.example.com,https://blog.example.com
```

The default is empty, which disables embedding. At most 32 origins are accepted; wildcards,
credentials, paths, queries and fragments are refused. HTTP is accepted only on loopback
hosts for development. The Hourmere instance also needs HTTPS outside loopback. Subdomains
and ports are separate origins. Keep the allow list narrow.

The parent website must permit the Hourmere origin in its own `script-src` and `frame-src`
Content Security Policy. The widget makes no changes to the parent site's policy. A parent
with a restrictive Permissions Policy may also prevent clipboard copying; the private
manage-link input can still be selected and copied manually.

## Inline

Use your full public booking URL; a team URL works in the same place.

```html
<div data-hourmere-inline
     data-hourmere-url="https://calendar.example.com/ada/intro"></div>
<script src="https://calendar.example.com/hourmere-embed.js" defer></script>
```

For a team, use `https://calendar.example.com/team/Alpha/intro`. Do not pass an app, sign-in,
API or manage URL, or a booking URL containing a query or fragment. The widget constructs
the separate `/embed/…` route with its parent origin and a random correlation identifier.
Those values contain no visitor or booking data. A manual iframe must follow the same
route, parent origin and identifier contract; using the script is recommended.

The iframe starts at 720px high and resizes between 240px and 2000px. Larger booking forms
scroll within the iframe. Its width follows the container; allow enough width for the form
(320px or more is recommended).

## Popup

```html
<button type="button" data-hourmere-popup
        data-hourmere-url="https://calendar.example.com/ada/intro">
  Book a meeting
</button>
<script src="https://calendar.example.com/hourmere-embed.js" defer></script>
```

The popup uses the browser's modal dialog: the rest of the page is inert, Close or Escape
removes it, and focus returns to the opener. Only one Hourmere popup is open at a time.
Use a browser supporting `HTMLDialogElement.showModal()`.

## JavaScript and single-page apps

After the script loads, `window.Hourmere` provides:

```js
const handle = window.Hourmere.initInline({
  element: document.querySelector('#booking'),
  url: 'https://calendar.example.com/ada/intro',
  height: 720, // optional integer, 240–2000
});
// Dispose when your page/component unmounts.
handle.destroy();

window.Hourmere.openPopup({ url: 'https://calendar.example.com/ada/intro' });
window.Hourmere.closePopup();
// Initialize newly added declarative elements after a client-side navigation.
window.Hourmere.init();
window.Hourmere.destroyInline(document.querySelector('#booking'));
```

Repeated initialization of a declarative inline placeholder creates one iframe. Calling
`initInline` on an existing container replaces its previous frame. Disposal removes the
frame and message listener; it leaves other container content alone.

A container receives `hourmere:booking-completed` when its iframe shows confirmation,
including a successful idempotent retry. The event has no details. Use it for a local UI
response; it is not a trusted billing or analytics record. Do not infer that every event
represents a new booking.

## Security and privacy

Only dedicated public booking routes can be framed, and only by the configured exact
parent. Normal booking pages, signed-in pages, sign-in, OAuth and invitee management retain
`X-Frame-Options: DENY` / `frame-ancestors 'none'`. Each embedded response's CSP names its
selected parent. The browser checks every ancestor, so nesting within a different-origin
outer frame is not supported. Invalid/missing embedding parameters receive 403.

The iframe is sandboxed without top navigation, sends no Referer, and never loads a web
session or account page. Scripts/forms, user-requested calendar downloads, and separate
calendar-site popups are allowed. Clipboard writing is delegated for the one-time private
manage-link copy button. Meeting links and brand links open separately with `noopener`
and `noreferrer`.

Child-to-parent messages contain only a correlation identifier plus a bounded height or a
confirmation or popup-close signal. Both sides use exact origins; the widget checks the sender Window,
origin, identifier and message shape. No booking ID, attendee, answer, email or manage token
is sent to the parent. Manage links remain within the Hourmere frame, with their token in
the fragment when the visitor copies them. The parent website must be trusted by visitors;
these controls cannot make an untrusted site's surrounding page trustworthy.

The public booking request may include `source: "embed"`. This is an anonymous attribution
hint, not proof of an embedding origin and never authorization. The default remains `web`;
API-key/OAuth attribution cannot be chosen through this field. Anonymous retries retain
their existing idempotency scope and preserve the original booking's source.

## Local development

On a fresh checkout, generate the standalone script before starting the development server:

```sh
npm exec --workspace @hourmere/web -- vite build --config vite.embed.config.ts
npm run dev
```

The ignored `apps/web/public/hourmere-embed.js` is generated automatically by production
builds. Rerun the first command after changing widget sources during development. Use a
separate loopback origin for the parent test page and include its exact origin in
`EMBED_ALLOWED_ORIGINS`.

## Interface language

Set `data-hourmere-language="zh-CN"` on a declarative inline or popup element, or pass
`language: 'zh-CN'` to `initInline` / `openPopup`, to initialize its Simplified Chinese
interface. Use `en` for English. These are the only accepted explicit values; an invalid
value fails before replacing a working widget. Without the option, the helper uses a
supported browser language or English. Visitors can change the iframe language without
losing a selected time, form answers or a completed booking. See
[interface languages](interface-languages.md) for preference and formatting behavior.
