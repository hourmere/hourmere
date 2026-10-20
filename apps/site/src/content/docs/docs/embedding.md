---
title: Website booking widgets
description: Embed a public booking page inline or in a popup.
---

Hourmere offers an iframe widget for personal and single-host team booking pages. Visitors
use the same public booking flow without signing in. Both variants keep Powered by Hourmere
branding. Embedded pages hide the page-level language picker and outer card frame while
retaining the form's panels and spacing. An iframe isolates the booking page, and a Shadow
DOM protects the popup title and close control from your website's styles.

First, the instance operator sets `EMBED_ALLOWED_ORIGINS` to your exact HTTPS website
origin (for example `https://www.example.com`) and restarts the web process. The default is
disabled. HTTP is supported only on loopback for development; wildcards and paths are not
accepted. The Hourmere instance also needs HTTPS outside loopback.

## Inline

```html
<div data-hourmere-inline
     data-hourmere-url="https://calendar.example.com/ada/intro"
     data-hourmere-height="720"></div>
<script src="https://calendar.example.com/hourmere-embed.js" defer></script>
```

Use a team URL such as `https://calendar.example.com/team/Alpha/intro` in the same attribute.
Use the full booking URL without a query or fragment. If your website has Content Security
Policy, allow the instance in `script-src` and `frame-src`.

The iframe starts at 720px high and resizes between 240px and 2000px. Optionally set
`data-hourmere-height` to an integer from 240 to 2000 to reserve its initial height and reduce
layout shifts. JavaScript's `height` option accepts the same range. Invalid declarative
heights show a load error. JavaScript calls reject invalid heights before replacing an
existing frame. Longer content scrolls inside the iframe; allow a container at least 320px
wide.

## Popup

```html
<button type="button" data-hourmere-popup
        data-hourmere-url="https://calendar.example.com/ada/intro">Book a meeting</button>
<script src="https://calendar.example.com/hourmere-embed.js" defer></script>
```

The modal has a dimmed backdrop and locks background scrolling while open. The top-right
44×44 close button, Escape (including inside the iframe), or a click outside the dialog
closes it and returns focus to the opener. Clicking its internal padding keeps the form
open. Only one popup is open at a time. It requires a browser supporting the native dialog
API.

The popup frame follows the visitor's system light or dark color scheme. At viewport widths
of 480px or less, it fills the screen without outer padding (`100vw` by `100dvh`). Otherwise
its maximum height is `90dvh`; older browsers fall back to the equivalent `vh` sizes.
Scrolling stays contained within the popup and booking frame.

Browsers supporting constructable `CSSStyleSheet` and `adoptedStyleSheets` can style the
popup under a strict parent `style-src` policy. Older browsers fall back to an inline style
element in the shadow root, which needs permission from the parent policy. Prefer a browser
with constructable stylesheet support for strict policies.

For client-side apps, call `window.Hourmere.init()` after adding placeholders or use
`initInline({element, url})`, whose returned `destroy()` must run when the component unmounts.
`openPopup({url})`, `closePopup()` and `destroyInline(element)` are also available.
Repeated loading failures reuse one alert per declarative element instead of stacking
duplicate messages.

## Interface language

Set `data-hourmere-language="zh-CN"` on an inline placeholder or popup button, or pass
`language: 'zh-CN'` to `initInline` or `openPopup`. Use `en` for English; unsupported explicit
values fail before replacing a working widget. Without an explicit language, the widget
uses a supported language from your page's `<html lang>`, then the browser, then English.
The popup title, accessible close-button label and booking page use that language. Embedded
pages have no page-level language picker, so choose the parent page or widget language
before initialization.

## Booking completion

A `hourmere:booking-completed` event fires on an inline container or a popup's focused opener
when the iframe shows confirmation, including retry confirmations. If the popup opener has
been removed, it fires on `document`. The event bubbles, so a listener on `document` handles
both modes:

```js
document.addEventListener('hourmere:booking-completed', () => {
  // Update your local UI; the event has no details.
});
```

The widget checks the iframe's completion postMessage origin, Window and correlation
identifier first. This is a UI signal, not a trusted booking or billing record, and repeated
confirmations do not necessarily mean new bookings. The popup stays open for the visitor to
copy their private manage link. Booking identifiers, attendee information, answers and manage
tokens are never sent to the parent. Manage links stay inside the Hourmere frame. Regular
account, OAuth and management pages cannot be framed. Nesting inside an outer frame with a
different origin is not supported.
