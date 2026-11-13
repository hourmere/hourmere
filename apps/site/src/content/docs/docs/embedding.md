---
title: Website booking widgets
description: Embed a public booking page inline or in a popup.
---

Hourmere offers an iframe widget for personal and team booking pages, including collective
meetings and activated round-robin pools. Visitors
use the same public booking flow without signing in. Both variants keep Powered by Hourmere
branding. Embedded pages hide the page-level language picker and outer card frame while
retaining the form's panels and spacing. An iframe isolates the booking page's styles, and
a Shadow DOM protects the popup title and close control from your website's styles.

Widgets reuse the public booking API and do not require a visitor account or third-party
cookies. Team embeds follow the same availability and host rules as
[collective meetings](/docs/collective-scheduling) and
[activated round-robin pools](/docs/round-robin-scheduling).

## Allow your website (instance operators)

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
and ports are separate origins. Keep the allow list narrow. The value lists the website
hosting the widget, not the Hourmere booking URL: allowing `https://www.example.com` does
not allow `https://example.com`, `https://preview.example.com` or
`https://www.example.com:8443`. Include each intended origin explicitly. This is an
instance setting, shared by personal and team embeds; hosts cannot change it in the dialog.
See [configuration](/docs/configuration) and [self-hosting](/docs/self-hosting) for operator setup.

The allowed-origins list is not secret. Any signed-in account can read it, including
any newly registered account when sign-up is open (`SIGNUP=open`). Do not include hostnames
you need to keep private. The **Allowed website origins** section of the Embed dialog
displays the list returned by `GET /api/v1/instance/embed`; see the access details below.

For a local parent website running on port 4321, for example:

```dotenv
PUBLIC_URL=http://localhost:5173
EMBED_ALLOWED_ORIGINS=http://localhost:4321
```

Open the parent page through its HTTP server, not a `file://` URL. `localhost` and
`127.0.0.1` are different origins. A page on an origin outside the allow list receives a
403 for the embed document and cannot display the booking flow. Copying code successfully
does not verify that its destination website is allowed.
The app's own origin has no exemption: embedding from `PUBLIC_URL` is refused unless that
exact origin is also in `EMBED_ALLOWED_ORIGINS`, and is allowed when explicitly listed.
The [origin check](https://github.com/hourmere/hourmere/blob/main/packages/core/src/embed.ts)
applies the same allow-list rule to app and third-party origins.

## Content Security Policy and iframes

The parent website must permit the Hourmere origin in its own `script-src` and `frame-src`
Content Security Policy. The widget makes no changes to the parent site's policy. A parent
with a restrictive Permissions Policy may also prevent clipboard copying; the private
manage-link input can still be selected and copied manually.
For the example instance, add `https://hourmere.example.com` to both directives.
Keep the rest of your website's policy. If a site
builder removes script tags or blocks external frames, enable its supported custom-HTML
integration before pasting the snippet. A reverse proxy must preserve Hourmere's dedicated
embed CSP and must not add `X-Frame-Options: DENY` to those embed responses. Ordinary
booking and account pages remain protected against framing; use the generated widget
instead of putting a normal booking URL in an iframe.

The popup uses a constructable stylesheet in browsers that support `CSSStyleSheet` and
`adoptedStyleSheets`, so its styles work with a strict `style-src` policy. Older browsers
fall back to a style element inside the shadow root; that fallback needs the parent policy
to permit those inline styles. Prefer a browser with constructable stylesheet support when
the parent uses a strict policy.

## Copy from the editor

1. In **Event types**, open and save a personal or team event type. Choose **Embed** in its
   **View and share** panel, or open the event row's **…** menu (announced as **More actions
   for** the event title) and choose **Embed**.
2. Check **Allowed website origins** for the site where you will paste the code. If the
   dialog says embedding is disabled, ask the instance operator to configure it as above.
3. Choose **Embed mode**. **Inline**, the default, puts the booking form directly in the
   page. **Initial height (pixels)** starts at **720** and accepts a whole number from
   **240** to **2000**; the widget resizes automatically after loading. **Popup button**
   puts a button in the page and opens the form when a visitor clicks it. Its **Button
   text** defaults to **Book a meeting** in English, or the equivalent in your admin
   interface language. Enter nonblank button text, up to 200 characters. The height field
   is only shown for Inline; the button-text field is only shown for Popup button.
4. Choose **Copy embed code** and paste the complete **Embed code**, including its script
   tag, into your website's HTML. Invalid height or blank button text prevents code from
   being offered. If clipboard access fails, select the read-only code and copy manually.
5. Load the page on an allowed origin and try a booking. Inline should show the form in
   the page; Popup button should open it in a modal. Confirm that the visitor can select
   a time, submit their details and reach the booking confirmation.

The code uses the instance's `PUBLIC_URL` and the saved booking address; unsaved edits
are not included. Save address changes and replace the snippet on your website afterward.
Changing the dialog's mode, height or button text only changes the code you copy; it does
not update a snippet already pasted into your website.

The dialog loads allowed website origins through the session-authenticated
`GET /api/v1/instance/embed` endpoint. The public `GET /api/v1/instance` endpoint exposes
only the optional `embedEnabled` flag, never the origin list. Every signed-in account,
including ordinary team members and newly registered accounts, can read the list;
API keys and MCP OAuth tokens cannot. The
[endpoint](https://github.com/hourmere/hourmere/blob/main/apps/server/src/routes/instance.ts)
requires a web session and current organization membership, with no administrator role
check. The [session resolver](https://github.com/hourmere/hourmere/blob/main/packages/auth/src/caller.ts)
falls back to the account's personal organization, so team membership is not required.
The [Embed dialog](https://github.com/hourmere/hourmere/blob/main/apps/web/src/pages/event-types/EventEmbedAction.tsx)
fetches that endpoint and displays its `embedAllowedOrigins` list.
If embedding is disabled, ask the instance operator to set `EMBED_ALLOWED_ORIGINS` using
the example above and restart the web process. You can still copy the code while waiting
for that configuration. A loading or unavailable configuration does not confirm whether
embedding is enabled. Loading shows only a neutral progress message; contact the operator
if the configuration remains unavailable after loading. The dialog does not load the booking widget inside the admin page;
test the copied code on an allowed website.

### Unlisted and inactive event types

Hidden event types are shown as **unlisted** in the dialog. They can be embedded through
their saved address without appearing in a public listing; anyone with the code or direct
link can book them. Unlisting is not access control. Inactive event types offer no embed
code: enable the event type and save before generating code. A previously copied embed
does not bypass inactivity or other booking availability rules. If saved setup is
incomplete, finish it before generating code. One-time booking links cannot be embedded;
use the event type's reusable public address. See [one-time booking links](/docs/one-time-links).

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
or heights of 480px or less, it fills the screen without outer padding (`100vw` by `100dvh`). Otherwise
its maximum height is `90dvh`; older browsers fall back to the equivalent `vh` sizes.
Scrolling stays contained within the popup and booking frame.

## Interface language

Set `data-hourmere-language="zh-CN"` on an inline placeholder or popup button, or pass
`language: 'zh-CN'` to `initInline` or `openPopup`, to initialize its Simplified Chinese
interface. Use `en` for English, `de` for German, `fr` for French, `es` for Spanish or `pt-BR`
for Brazilian Portuguese. These
are the accepted explicit values; an invalid value fails before replacing a working widget. Without an explicit language, the widget
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

Configure an optional target and its parameters in the editor or through REST, MCP or CLI;
see [after-booking redirects](/docs/after-booking).

An event type can have a host-configured continuation link after the normal confirmation,
calendar information and private manage link. Visitors choose **Continue**; there is no
automatic navigation. Embedded continuations open a new tab with `noopener noreferrer`
unless the event type separately opts in to opening the parent page. The widget grants
user-activated top navigation only for that saved opt-in. It checks the capability before
allowing input and reloads the same booking route when sandbox permissions change,
before visitors can enter form data. Loading and server-error text remains visible.
Error and unavailable pages signal readiness without granting parent navigation. If a page
cannot finish loading or send readiness within five seconds, the widget enables input with
the restricted sandbox; a stalled permission upgrade first replaces the frame with the
restricted route, removing the old document's navigation permission.
Late readiness never reloads a frame after input has been enabled.
Enabling the opt-in after a restrictive frame has loaded keeps Continue in a new tab for
that visit. Older widgets that send an embed identifier without the permission marker also
keep Continue in a new tab. The stable `hourmere-embed.js` URL is revalidated on every visit
using `Cache-Control: no-cache` and an ETag. Manual iframes must provide their own matching sandbox
permission to support this opt-in; the widget is recommended.

If the operator tightens the redirect-host policy or changes the instance's public host,
a previously saved target may become ineligible. Booking still succeeds with the normal
confirmation and no continuation. The operator can identify the event type from the safe
`success_redirect_disabled` log and help its host replace or clear the target.

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

The iframe is sandboxed without top navigation by default; only a saved event-type opt-in
adds `allow-top-navigation-by-user-activation`. This token permits any user-activated top
navigation in the frame, so the browser does not restrict it to the configured Continue
URL. Keep the embedded origin and host-authored content trusted. It sends no Referer and never loads a web
session or account page. Scripts/forms, user-requested calendar downloads, and separate
calendar-site popups are allowed. Clipboard writing is delegated for the one-time private
manage-link copy button. Meeting links and brand links open separately with `noopener`
and `noreferrer`.

Child-to-parent messages contain only a correlation identifier plus a bounded height, a
saved parent-navigation capability, or a confirmation or popup-close signal. A permission
reload rotates the identifier to reject messages from the retiring document. Both sides
use exact origins; the widget checks the sender Window,
origin, identifier and message shape. No booking ID, attendee, answer, email or manage token
is sent to the parent. Manage links remain within the Hourmere frame, with their token in
the fragment when the visitor copies them. The parent website must be trusted by visitors;
these controls cannot make an untrusted site's surrounding page trustworthy.

The public booking request may include `source: "embed"`. This is an anonymous attribution
hint, not proof of an embedding origin and never authorization. The default remains `web`;
API-key/OAuth attribution cannot be chosen through this field. Anonymous retries retain
their existing idempotency scope and preserve the original booking's source.

## Known limitations

- The generator offers Inline, its initial height, Popup button and its button text. It
  has no live preview, language selector, color picker or visitor-prefill fields. For an
  explicit widget language, add the documented language attribute yourself; the popup
  button's text and the booking interface language are separate choices.
- Both modes retain Powered by Hourmere branding. The iframe isolates the booking form
  from your site's CSS; styling the surrounding page does not restyle the form.
- Only reusable personal and team booking addresses are supported. Account pages,
  private management links and one-time booking links cannot be embedded. A hidden event
  remains bookable through its link, while an inactive event does not become bookable by
  embedding it.
- JavaScript and iframe support are required. Popup mode also requires a browser with
  modal-dialog support. Nested frames with a different-origin outer ancestor are not
  supported. Host pages must satisfy the origin and CSP requirements above.
- Copying a snippet does not check availability, reserve a time or publish website
  changes. Test the deployed parent page after changing the snippet or operator settings.
  The booking-completed event is a UI notification without booking details; use
  [webhooks](/docs/webhooks) for server-side booking integrations.

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
