---
title: Website booking widgets
description: Embed a public booking page inline or in a popup.
---

Hourmere offers an iframe widget for personal and single-host team booking pages. Visitors
use the same public booking flow without signing in. Both variants keep Powered by Hourmere
branding.

First, the instance operator sets `EMBED_ALLOWED_ORIGINS` to your exact HTTPS website
origin (for example `https://www.example.com`) and restarts the web process. The default is
disabled. HTTP is supported only on loopback for development; wildcards and paths are not
accepted. The Hourmere instance also needs HTTPS outside loopback.

## Inline

```html
<div data-hourmere-inline
     data-hourmere-url="https://calendar.example.com/ada/intro"></div>
<script src="https://calendar.example.com/hourmere-embed.js" defer></script>
```

Use a team URL such as `https://calendar.example.com/team/Alpha/intro` in the same attribute.
Use the full booking URL without a query or fragment. If your website has Content Security
Policy, allow the instance in `script-src` and `frame-src`.

## Popup

```html
<button type="button" data-hourmere-popup
        data-hourmere-url="https://calendar.example.com/ada/intro">Book a meeting</button>
<script src="https://calendar.example.com/hourmere-embed.js" defer></script>
```

The modal supports Close and Escape and returns focus to the opener. It requires a browser
supporting the native dialog API. The iframe starts at 720px high and resizes up to 2000px;
longer content scrolls inside it.

For client-side apps, call `window.Hourmere.init()` after adding placeholders or use
`initInline({element, url})`, whose returned `destroy()` must run when the component unmounts.
`openPopup({url})`, `closePopup()` and `destroyInline(element)` are also available.

A `hourmere:booking-completed` event on the container has no details; it is a UI signal,
including retry confirmations. Booking identifiers, attendee information, answers and manage
tokens are never sent to the parent. Manage links stay inside the Hourmere frame. Regular
account, OAuth and management pages cannot be framed. Nesting inside an outer frame with a
different origin is not supported.
