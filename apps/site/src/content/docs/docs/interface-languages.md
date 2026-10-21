---
title: Interface languages
description: Choose English or Simplified Chinese in the web interface and booking widgets.
---

The web interface is available in English and Simplified Chinese. The language control is
available on sign-in, account and standalone public booking pages.
Changing it updates the existing page without restarting a form, discarding a chosen time,
reissuing a booking or replacing its private management link.

An explicit interface choice takes precedence over a supported signed-in profile default,
then the browser's supported language, then English. Signed-in routes read the existing
profile after authentication; public routes never request a session or profile to choose a
language. The interface choice is separate from the profile's **Language** BCP 47 field:
changing the interface never saves the profile. A supported profile default is loaded when
the authenticated account becomes available. Unsupported profile locale values remain
valid profile settings.

Without an explicit interface choice, date and time formatting retains the browser's
full BCP 47 locale, including locales whose interface text falls back to English. Choosing
English or Simplified Chinese explicitly also chooses that display format. Dates retain the
Gregorian calendar and the selected IANA time zone. A booking flow freezes its request
locale independently of display changes, so retrying after a lost response keeps the same
body and idempotency key.

The language preference stores only the tiny allowlisted value `en` or `zh-CN`, under
`hourmere-language` in local storage and a same-name `SameSite=Lax`, path-wide cookie. The
cookie has a one-year lifetime and is `Secure` on HTTPS. Refusing either storage mechanism
does not prevent changing the current page. No account identifiers, answers or management
capabilities enter preference storage. The standalone email sign-in confirmation page uses
the same preference cookie, then `Accept-Language`, and provides its own language buttons.
Language changes never submit that form or change its fragment.

Public booking and rescheduling pages also remember an explicitly selected IANA time
zone in local storage. A valid saved choice becomes the default on later visits; browser
detection alone does not save a preference. The picker still includes the browser's zone.
Blocked storage does not prevent choosing a zone for the current visit. Individual
booking pages show the host's profile zone and, when it differs from the visitor's chosen
zone, the selected meeting time for the host. Round-robin pages wait until a host is assigned.

User-provided event titles, descriptions, names, answers, locations and question options
are left as entered. Known error codes have fixed local messages. Unknown server prose is
shown verbatim rather than interpreted as a translation key. API, MCP and CLI machine
protocols, notification email templates, website and legal pages are outside this interface
translation catalog.

## Widgets

The standalone helper accepts an optional, strictly validated `language` value in
`initInline` and `openPopup`, or `data-hourmere-language` on declarative elements. Only `en`
and `zh-CN` are accepted. Without an explicit value, the helper uses the host page's supported
`<html lang>`, then a supported browser language, then English. Embedded pages hide their
page-level language picker; choose the page or widget language before initialization.
The iframe receives only that non-sensitive allowlisted value in its
`language` query parameter. Existing exact origin, source and instance checks still apply;
completion messages contain no booking or attendee data.

## Development

[`apps/web/src/i18n/common.ts`](https://github.com/hourmere/hourmere/blob/main/apps/web/src/i18n/common.ts) contains public/shared message keys and Simplified Chinese
text. The separate [`admin.ts`](https://github.com/hourmere/hourmere/blob/main/apps/web/src/i18n/admin.ts) catalog is registered only through the existing lazy session
graph. English text is the typed semantic key. Use `t(key, values)` during render and
`msg(key, values)` for a notice or validation message held in state. Nested messages, date
arguments and lists are formatted when rendered, so an already visible message follows a
language change. Plain interpolation arguments remain literal user content. Wrap arbitrary
server prose or user-generated page titles in `literal(text)`.

Do not translate protocol fields, create language-based React keys, replace arbitrary DOM
text, add private session lookups to public routes, or include capabilities in language
parameters or preferences. Test both languages and preserve the existing arbitrary-locale,
Gregorian, daylight-saving and privacy regressions when adding pages.
