# Mail templates

`@hourmere/mail` provides transactional email rendering and the existing SMTP and
development log mailers. Team invitation rendering is available independently of delivery:
creating a Better Auth invitation still sends no email. This template adds no hooks, jobs,
delivery storage or transport configuration.

## Team invitations

`teamInvitationEmail(options)` returns a `MailMessage` containing an English, Simplified
Chinese, German, French, Spanish or Brazilian Portuguese subject, plain-text body and HTML body:

```ts
import { teamInvitationEmail } from '@hourmere/mail'

const message = teamInvitationEmail({
  to: 'recipient@example.com',
  publicUrl: 'https://hourmere.example.com',
  invitationId: '7b9c29a0-fca6-4ed0-b697-a1ba31c9ee10',
  teamName: 'Example team',
  inviterName: 'Alex',
  expiresAt: '2026-10-29T18:00:00.000Z',
  language: 'zh-CN',
  defaultLanguage: 'en',
})
```

This example renders a message only; it does not send one.

| Option | Meaning |
| --- | --- |
| `to: string` | The invited email address. Both bodies tell the recipient to sign in with this address and verify it before accepting. |
| `publicUrl: string` | The instance's own configured canonical HTTP(S) origin, supplied by trusted server configuration; an optional trailing `/` is accepted. Never take it from a request, invitation field or callback parameter. |
| `invitationId: string` | Invitation UUID; the only variable accepted in the join URL. |
| `teamName: string` | User-controlled team display name. |
| `inviterName: string` | User-controlled inviter display name; pass the name, without an email-address fallback. |
| `expiresAt: Date \| string` | The invitation expiry instant: Better Auth's direct API returns `Date` objects; HTTP JSON uses ISO timestamps with a time-zone offset. Both bodies show the same UTC timestamp. |
| `language?: unknown` | An explicit language chosen by the inviter. |
| `defaultLanguage?: unknown` | An optional instance language supplied by the caller; no new environment setting is added. |

Language selection uses `interfaceLanguage` from `@hourmere/core/language`: a supported
`language`, then a supported `defaultLanguage`, then `en`. English locale variants resolve
to English, Simplified Chinese variants to `zh-CN`, and German variants (including `de-AT`
and `de-CH`) to `de`. French variants (including `fr-CA`, `fr-BE` and `fr-CH`) resolve to `fr`;
Spanish variants (including `es-ES`, `es-MX`, `es-419`, `es-AR`, `es-CO` and `es-US`)
resolve to `es`, with `es-ES` date and time formatting. `pt-BR`, bare `pt` and other
Latin-script Portuguese variants such as `pt-AO` resolve to `pt-BR`, using Brazilian date
and 24-hour time formatting. European Portuguese (`pt-PT`) is excluded and falls through to
the next supported language choice, then English, rather than receiving Brazilian text.
Unsupported or invalid values fall
through. For example, `zh-TW` does not select the Simplified Chinese template. The renderer
does not inspect cookies, request headers, URL language fields or cross-site callbacks.

The renderer builds one accept URL from `publicUrl` and the fixed path
`/app/join?invitationId=<uuid>`. The HTML button, HTML fallback link and plain-text link all
use that URL. The origin parser rejects credentials, non-root paths, query strings,
fragments and control characters; it does not accept an arbitrary accept URL or redirect
destination. Unknown extra fields cannot change the link or language. This API relies on
the caller obtaining `publicUrl` from the instance configuration: parsing an origin cannot
establish that an otherwise valid origin belongs to this instance.

The `/app/join` path comes from the proposed team-join page contract. The renderer does not
implement that page. Confirm the path and query name with the page implementation before
wiring delivery. Opening the link or signing in does not itself accept an invitation.
Invitation lookup and acceptance retain their own authenticated, verified, exact invited
email checks; an email link grants no sign-up authority.

Both formats contain the team name, safe inviter display name, expiry, invited-email
sign-in requirement and accept URL. User text is normalized through the existing mail text
helpers, including repair of malformed Unicode; HTML text and URL attributes are escaped.
An empty inviter name uses the localized equivalent of “a team member”, with no fallback to
the inviter's email. An empty team name uses “Your team” or its Chinese equivalent.
Validation errors are generic and do not repeat the invalid input.

Messages have `sensitive: true`. The existing development log mailer emits only its generic
sensitive-message notice, without recipient, subject, body or usable link. Keep that flag
when passing a rendered message to a mailer, and never log the returned message or a raw
invitation URL yourself.

Invitation business states such as `pending`, `accepted` and `canceled` remain separate
from future delivery states. Rendering proves neither delivery nor acceptance; SMTP
acceptance would not establish inbox receipt. Durable delivery, retry/reconciliation,
Better Auth `sendInvitationEmail` wiring and delivery status are later work.
