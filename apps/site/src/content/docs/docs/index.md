---
title: Documentation
description: Run Hourmere yourself and connect booking clients through REST or MCP.
---

Hourmere is in early development. These guides describe the current source tree; there is
no stable release yet; the open-source release is planned for **2026-11-30**. Hourmere Cloud
is an [invitation-only preview](/#faq) with sign-ups closed.
The website at hourmere.com is separate from your Hourmere instance.

- [Self-host with Docker Compose](/docs/self-hosting): install, configure email and a proxy,
  split workers, back up and upgrade.
- [Configuration reference](/docs/configuration): environment variables and Compose behavior.
- [Troubleshooting](/docs/troubleshooting): email delivery, workers, HTTPS, DNS and database
  startup failures.
- [Compare scheduling options](/docs/comparison): deployment, agent access and the current
  limitations of Hourmere alongside Calendly, Cal.com and Cal.diy.
- [Multiple meeting lengths](/docs/multiple-durations): configure the offered lengths and
  default, and learn how invitees choose and reschedule.
- [After-booking redirects](/docs/after-booking): offer a Continue link with explicit
  parameter, privacy and embed permissions.
- [One-time booking links](/docs/one-time-links): create, list and revoke private links
  through the editor, REST, MCP or CLI, with the booking URL shown once.
- [Reminders and follow-ups](/docs/reminders-and-follow-ups): choose email times, recipients
  and optional host notes, with delivery limits and configuration examples.
- [Open-time snippets for agents](/docs/open-time-snippets): draft an email with current
  alternatives and direct booking links through REST, MCP or CLI.
- [REST quickstart](/docs/rest): create an API key and find, book and manage a time slot.
- [MCP quickstart](/docs/mcp): connect a client with an API key and use the booking tools.
- [Google Calendar](/docs/google-calendar): configure separate calendar authorization and
  choose busy-time calendars and a booking destination.
- [Microsoft Calendar](/docs/microsoft-calendar): register an Entra application and connect,
  refresh or disconnect an Outlook calendar list. Busy-time sync and event writes are pending.

- [Booking waitlists](/docs/booking-waitlist): let invitees confirm an empty period and
  receive notification when a matching time opens; manage entries in the editor, REST,
  MCP or CLI. Available in full to self-hosters.

## Known limitations

- [Booking waitlists](/docs/booking-waitlist#known-limitations) support one-on-one
  single-host types at the default meeting length. Nothing is reserved; the first
  successful ordinary booking wins, and email delivery is not guaranteed.
- Group seats currently have internal storage and service support only. Public booking
  pages, event editors and REST/MCP/CLI group configuration do not enable group mode yet;
  this limitation applies equally to self-hosted installations.

- Public booking and sign-in pages have no CAPTCHA; invitee/guest email addresses remain
  unverified. [Email abuse limits](/docs/notifications#email-abuse-controls) apply per
  instance/database; separate instances do not share budgets. Per-IP request limits remain
  in process memory, except the additional durable booking-waitlist admission limits.
- [Microsoft Calendar](/docs/microsoft-calendar) lists calendars only, without busy-time
  synchronization or event writes. [Microsoft sign-in](/docs/configuration#sign-in-with-microsoft)
  and calendar connections have not had real-account acceptance.
- [Automatic Zoom](/docs/automatic-zoom)
  supports personal event types and individual team event types with one actual host;
  collective and round-robin event types are unsupported.
- [Multiple meeting lengths](/docs/multiple-durations) share one set of hosts, location
  and booking rules; per-length overrides are unavailable. Web rescheduling keeps the
  original length; changing it requires REST, MCP or CLI.
- [Calendar RSVP replies](/docs/notifications#email-headers-mime-and-replies)
  are not processed; declining in a calendar does not cancel an Hourmere booking. Use
  Hourmere's cancellation action; operators must [handle replies manually](/docs/self-hosting#handle-calendar-replies).
- [Follow-ups](/docs/reminders-and-follow-ups) use the scheduled end regardless of
  attendance. Invitees cannot stop them after the meeting starts; cancel in Hourmere
  before the start. Mail limits can permanently suppress a message.
- PostgreSQL 18+ is required for `uuidv7()`; [PgBouncer is unsupported](/docs/configuration#server-and-database).
  The [upgrade notes](https://github.com/hourmere/hourmere/blob/main/CHANGELOG.md#upgrade-notes)
  cover the database version requirement.
- Hourmere must be served at the root of its own host name (no path prefix) in every deployment.
  [Bundled Caddy](/docs/self-hosting#prepare-the-host) additionally requires ports 80/443,
  an HTTPS host name without a port, and an IPv4-only ingress network.
- [Rate limiting](https://github.com/hourmere/hourmere/blob/main/apps/server/src/rate-limit.ts)
  uses in-process memory at the transport layer; multiple web replicas multiply the limits.
  Waitlists additionally enforce durable mailbox, event and trusted-IP admission budgets. Run a single web process;
  a [separate worker](/docs/self-hosting#run-workers-separately) is supported.
- [Public booking pages and emails](/docs/interface-languages) support English,
  Simplified Chinese, German, French, Spanish and Brazilian Portuguese. Account and sign-in interfaces support English and
  Simplified Chinese. Missing translations fall back to English;
  dates use the active language with the existing time-zone rules.
- [Schema downgrade is not automatic](/docs/self-hosting#upgrade-and-roll-back). Some
  migrations are not rolling-upgrade safe: stop all old app and worker processes as required
  by the [migration notes](https://github.com/hourmere/hourmere/blob/main/docs/data-model.md#changing-the-schema)
  and [calendar-email upgrade notes](/docs/notifications#identity-and-recipients).

## More guides

Explore these detailed guides:

- [CLI](/docs/cli): use the booking tools
  from a terminal with an API key.
- [Booking webhooks](/docs/webhooks):
  configure signed delivery and retries.
- Team scheduling: [collective meetings](/docs/collective-scheduling)
  and [round-robin pools](/docs/round-robin-scheduling).
- [Automatic Google Meet](/docs/automatic-google-meet)
  and [automatic Zoom](/docs/automatic-zoom):
  configure explicit meeting creation and recovery.
- [Notifications and background jobs](/docs/notifications):
  understand delivery, retries and calendar invitations.

The software is licensed under AGPL-3.0. File bugs and feature ideas in
[GitHub Issues](https://github.com/hourmere/hourmere/issues). Report vulnerabilities privately
to [security@hourmere.com](mailto:security@hourmere.com) or through the repository's
[Security tab](https://github.com/hourmere/hourmere/security/advisories/new).
