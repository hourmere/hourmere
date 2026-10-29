---
title: Interface languages
description: Choose a registered interface language, with English fallback and localized dates.
---

Public booking, cancellation and rescheduling pages, embedded widgets and notification
emails are available in English, Simplified Chinese and German. The account and sign-in
interfaces remain available in English and Simplified Chinese. The language control is
available on sign-in, account and standalone public booking pages.

German translations are AI-assisted (machine-translated) and have not yet been reviewed
by a native speaker. Corrections are welcome through a GitHub issue or pull request.
German regional preferences such as `de-AT` and `de-CH` resolve to `de`.
Changing it updates the existing page without restarting a form, discarding a chosen time,
reissuing a booking or replacing its private management link.

An explicit interface choice takes precedence over a supported signed-in profile default,
then the browser's supported language, then English. A choice unavailable for the current
interface is skipped: the profile default and browser language are checked before the
registry's English fallback, without replacing the saved preference. For example, a saved
German choice on an account page still allows a Chinese profile or browser default.
Signed-in routes read the existing profile after authentication; public routes never request
a session or profile to choose a language. The interface choice is separate from the
profile's **Language** BCP 47 field:
changing the interface never saves the profile. A supported profile default is loaded when
the authenticated account becomes available. Unsupported profile locale values remain
valid profile settings.

An explicit interface choice uses its registered date and time format. A supported
non-English profile or browser default uses that language's format too. Otherwise formatting retains
the browser's full BCP 47 locale, including regional English formats and locales whose
interface text falls back to English. Dates retain the
Gregorian calendar and the selected IANA time zone. A booking flow freezes its request
locale independently of display changes, so retrying after a lost response keeps the same
body and idempotency key.

The language preference stores only a registered language code (currently `en`, `zh-CN` or `de`), under
`hourmere-language` in local storage and a same-name `SameSite=Lax`, path-wide cookie. The
cookie has a one-year lifetime and is `Secure` on HTTPS. Refusing either storage mechanism
does not prevent changing the current page. No account identifiers, answers or management
capabilities enter preference storage. Sign-in emails and the standalone email sign-in
confirmation page use the same admin-surface language rules: a valid preference cookie
is used only when its language is available on the admin surface. An unavailable cookie,
such as German, is treated as absent without changing the saved preference. A supported
account default follows where the account is already known, then quality-ranked
`Accept-Language` chooses an admin-supported language, then English. No account or profile
lookups are added to public sign-in requests just to choose a language; the confirmation
page uses only the request headers. A German cookie with `Accept-Language: zh-CN` therefore
gives Simplified Chinese, while the same cookie with `Accept-Language: de-CH` gives English.
A Simplified Chinese cookie takes precedence over `Accept-Language`. The confirmation page
provides the supported sign-in language choices. Language changes never submit that form
or change its fragment.

Public booking and rescheduling pages also remember an explicitly selected IANA time
zone in local storage. A valid saved choice becomes the default on later booking-page visits;
browser detection alone does not save a preference. Each manage link starts in that booking's
stored invitee zone, matching its emails, or the browser zone if the stored zone is unavailable.
A choice made on the manage page applies for that view and future booking-page visits.
The picker still includes the browser's zone.
Blocked storage does not prevent choosing a zone for the current visit. Individual booking
pages show the host's profile zone and, when the selected instant has a different local time
in that known zone, the meeting time for the host. Round-robin pages wait until a host is assigned.

User-provided event titles, descriptions, names, answers, locations and question options
are left as entered. Known error codes have fixed local messages. Unknown server prose is
shown verbatim rather than interpreted as a translation key. API, MCP and CLI machine
protocol fields stay stable across languages. [Notification emails](/docs/notifications#email-language)
use the same locale registry with their own catalogues. Website and legal pages are outside
the product's translation catalogues.

## Widgets

The standalone helper accepts an optional, strictly validated `language` value in
`initInline` and `openPopup`, or `data-hourmere-language` on declarative elements. Values
must be exact registered codes (currently `en`, `zh-CN` and `de`). Without an explicit value, the helper uses the host page's supported
`<html lang>`, then a supported browser language, then English. Embedded pages hide their
page-level language picker; choose the page or widget language before initialization.
The iframe receives only that non-sensitive allowlisted value in its
`language` query parameter. Existing exact origin, source and instance checks still apply;
completion messages contain no booking or attendee data.

## English fallback

Every message resolves independently through the selected locale's fallback chain and then
English. A partially translated language can show its translated labels alongside complete
English messages; missing keys never display internal identifiers. Literal user content stays
unchanged. This applies to interface text, widget controls, email subjects and bodies, and
generated calendar summary/description text. Dates continue to use the selected language's
format even when an individual message falls back to English.

REST `invitee.locale`, MCP `create_booking` and CLI `book` accept the same optional BCP 47
locale. Host notifications use the host's profile; guests follow the booker's saved language.
Unsupported tags use English notifications without rejecting an otherwise valid booking.
Locale changes do not alter time zones, UTC API timestamps, idempotency or calendar identity.
The OpenAPI locale descriptions list the registered languages; profile locale values remain
general BCP 47 preferences rather than a closed enum.

## Development

Add one entry to
[`packages/core/src/locales.ts`](https://github.com/hourmere/hourmere/blob/main/packages/core/src/locales.ts):
code, native name, ordered fallback codes, Intl formatting locale and `ltr` direction.
An optional `interfaces` list limits a language to `public` or `admin` interfaces; omitting
it enables both. Notification language choices remain independent of this UI scope.
Add the corresponding catalogue files; loaders and language selectors discover them automatically:

- `apps/web/src/i18n/catalogues/{code}/common.ts`: public/shared messages (`common` export).
- `apps/web/src/i18n/catalogues/{code}/admin.ts`: account messages (`admin` export), kept in the lazy session graph.
- `apps/web/src/i18n/catalogues/{code}/widget.ts`: widget controls (`widget` export).
- `packages/mail/src/catalogues/{code}.json`: booking, team invitation and sign-in email and generated calendar copy.
- `apps/server/src/i18n/catalogues/{code}.json`: the standalone sign-in confirmation page.

Use the existing English files as the key and placeholder reference. Partial catalogues are
allowed for future languages. Catalogue tests report each locale's coverage, warn about
missing translations for new locales, and fail for malformed or mismatched placeholders.
English and Simplified Chinese remain complete. German public catalogues and mail tables
are also required to match every English key and placeholder; German has no admin catalogue.

Use `t(key, values)` during render and `msg(key, values)` for a notice or validation message
held in state. Nested messages, date arguments and lists format when rendered, so visible
messages follow language changes. Plain interpolation arguments remain literal user content;
wrap arbitrary server prose or user-generated page titles in `literal(text)`.

Do not translate protocol fields, create language-based React keys, replace arbitrary DOM
text, add private session lookups to public routes, or include capabilities in language
parameters or preferences. Preserve arbitrary-locale, Gregorian, daylight-saving and privacy
regressions when adding pages.
