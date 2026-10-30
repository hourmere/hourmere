---
title: Website booking widgets
description: Embed a public booking page inline or in a popup.
---

Hourmere offers an iframe widget for personal and single-host team booking pages. Visitors
use the same public booking flow without signing in. Both variants keep Powered by Hourmere
branding. Embedded pages hide the page-level language picker and outer card frame while
retaining the form's panels and spacing. An iframe isolates the booking page's styles, and
a Shadow DOM protects the popup title and close control from your website's styles.

Widgets reuse the public booking API and do not require a visitor account or third-party
cookies.

First, the instance operator sets `EMBED_ALLOWED_ORIGINS` to your exact HTTPS website
origin (for example `https://www.example.com`) and restarts the web process. The default is
empty, which disables embedding.

For example:

```dotenv
PUBLIC_URL=https://hourmere.example.com
EMBED_ALLOWED_ORIGINS=https://www.example.com,https://blog.example.com
```

At most 32 origins are accepted; wildcards,
credentials, paths, queries and fragments are refused. HTTP is accepted only on loopback
hosts for development. The Hourmere instance also needs HTTPS outside loopback. Subdomains
and ports are separate origins. Keep the allow list narrow.

The parent website must permit the Hourmere origin in its own `script-src` and `frame-src`
Content Security Policy. The widget makes no changes to the parent site's policy. A parent
with a restrictive Permissions Policy may also prevent clipboard copying; the private
manage-link input can still be selected and copied manually.

The popup uses a constructable stylesheet in browsers that support `CSSStyleSheet` and
`adoptedStyleSheets`, so its styles work with a strict `style-src` policy. Older browsers
fall back to a style element inside the shadow root; that fallback needs the parent policy
to permit those inline styles. Prefer a browser with constructable stylesheet support when
the parent uses a strict policy.

## Inline

```html
<div data-hourmere-inline
     data-hourmere-url="https://hourmere.example.com/ada/intro"
     data-hourmere-height="720"></div>
<script src="https://hourmere.example.com/hourmere-embed.js" defer></script>
```

Use your full public booking URL; a team URL works in the same place.
For a team, use `https://hourmere.example.com/team/Alpha/intro`. Do not pass an app, sign-in,
API or manage URL, or a booking URL containing a query or fragment. The widget constructs
the separate `/embed/…` route with its parent origin and a random correlation identifier.
Those values contain no visitor or booking data. A manual iframe must follow the same
route, parent origin and identifier contract; using the script is recommended.

The iframe starts at 720px high and resizes between 240px and 2000px. Optionally set
`data-hourmere-height` to an integer from 240 to 2000 to reserve its initial height and reduce
layout shifts. JavaScript's `height` option accepts the same range. Invalid declarative
heights show a load error. JavaScript calls reject invalid heights before replacing an
existing frame. Longer content scrolls inside the iframe. Its width follows the container;
allow a container at least 320px wide.

## Popup

```html
<button type="button" data-hourmere-popup
        data-hourmere-url="https://hourmere.example.com/ada/intro">Book a meeting</button>
<script src="https://hourmere.example.com/hourmere-embed.js" defer></script>
```

The popup uses the browser's modal dialog with a visible dimmed backdrop: the rest of the
page is inert and background scrolling is locked until it closes. The top-right 44×44 close
button, Escape (including inside the iframe), or a click outside the dialog closes it and
returns focus to the opener. Clicking inside the dialog's padding keeps the form open.
Only one Hourmere popup is open at a time. Use a browser supporting
`HTMLDialogElement.showModal()`.

The popup frame follows the visitor's system light or dark color scheme. At viewport widths
of 480px or less, it fills the screen without outer padding (`100vw` by `100dvh`). Otherwise
its maximum height is `90dvh`; older browsers fall back to the equivalent `vh` sizes.
Scrolling stays contained within the popup and booking frame.

## Interface language

Set `data-hourmere-language="zh-CN"` on an inline placeholder or popup button, or pass
`language: 'zh-CN'` to `initInline` or `openPopup`, to initialize its Simplified Chinese
interface. Use `en` for English or `de` for German. These are the accepted explicit values; an invalid
value fails before replacing a working widget. Without an explicit language, the widget
uses a supported language from your page's `<html lang>`, then a supported browser language,
then English.
The popup title, accessible close-button label and booking page use that language. Embedded
pages have no page-level language picker, so choose the parent page or widget language
before initialization. See [interface languages](/docs/interface-languages) for preference
and formatting behavior.

## Booking completion

A `hourmere:booking-completed` event fires on an inline container or a popup's focused opener
when the iframe shows confirmation, including successful idempotent retry confirmations. If
the popup opener has been removed, it fires on `document`. The event bubbles, so a listener
on `document` handles both modes:

```js
document.addEventListener('hourmere:booking-completed', () => {
  // Update your local UI; the event has no details.
});
```

The widget validates the iframe's `hourmere:booked` postMessage against its exact origin,
Window and correlation identifier before dispatching this event. This is a UI signal, not a
trusted booking, billing or analytics record, and repeated confirmations do not necessarily
mean new bookings. The popup stays open for the visitor to copy their private manage link.

## JavaScript and single-page apps

After the script loads, `window.Hourmere` provides:

```js
const handle = window.Hourmere.initInline({
  element: document.querySelector('#booking'),
  url: 'https://hourmere.example.com/ada/intro',
  height: 720, // optional integer, 240–2000
});
// Dispose when your page/component unmounts.
handle.destroy();

window.Hourmere.openPopup({ url: 'https://hourmere.example.com/ada/intro' });
window.Hourmere.closePopup();
// Initialize newly added declarative elements after a client-side navigation.
window.Hourmere.init();
window.Hourmere.destroyInline(document.querySelector('#booking'));
```

Repeated initialization of a declarative inline placeholder creates one iframe. Calling
`initInline` on an existing container replaces its previous frame. Disposal removes the
frame and message listener; it leaves other container content alone.
Repeated loading failures reuse one alert for each declarative element instead of adding
duplicate messages.

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
